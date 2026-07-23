import { getPrisma } from "@/lib/prisma";
import { activeRegistrationStatuses } from "@/modules/events/lifecycle";
import { Prisma } from "@prisma/client";

const activeRegistrationStatusSet = new Set<string>(activeRegistrationStatuses);

export type CheckInOperationDisposition =
  | "CREATED"
  | "IDEMPOTENT_REPLAY"
  | "ALREADY_CHECKED_IN";

export class CheckInOperationError extends Error {
  constructor(
    public readonly code:
      | "ATTENDEE_NOT_FOUND"
      | "REGISTRATION_NOT_ELIGIBLE"
      | "IDEMPOTENCY_KEY_REUSED"
      | "CHECK_IN_OPERATION_CONFLICT",
  ) {
    super(
      code === "REGISTRATION_NOT_ELIGIBLE"
        ? "Only submitted or confirmed registrations can be checked in."
        : code === "IDEMPOTENCY_KEY_REUSED"
          ? "This retry key was already used for another attendee."
          : code === "CHECK_IN_OPERATION_CONFLICT"
            ? "Another staff action changed this attendee at the same time. Retry to load the final result."
        : "The attendee was not found.",
    );
    this.name = "CheckInOperationError";
  }
}

function retryableTransactionError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && (error.code === "P2034" || error.code === "P2002");
}

export async function checkInAttendee(
  eventId: string,
  attendeeId: string,
  actorUserId: string,
  idempotencyKey: string,
) {
  const prisma = getPrisma();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const replay = await tx.checkIn.findUnique({
          where: {
            eventId_idempotencyKey: {
              eventId,
              idempotencyKey,
            },
          },
        });
        if (replay) {
          if (replay.registrationAttendeeId !== attendeeId) {
            throw new CheckInOperationError("IDEMPOTENCY_KEY_REUSED");
          }
          return {
            checkIn: replay,
            disposition: "IDEMPOTENT_REPLAY" as const,
            checkedIn: replay.undoneAt === null,
          };
        }

        const attendee = await tx.registrationAttendee.findFirst({
          where: { id: attendeeId, eventId },
          include: {
            registration: { select: { status: true } },
            checkIns: {
              where: { undoneAt: null },
              orderBy: { checkedInAt: "desc" },
              take: 1,
            },
          },
        });
        if (!attendee) {
          throw new CheckInOperationError("ATTENDEE_NOT_FOUND");
        }
        if (!activeRegistrationStatusSet.has(attendee.registration.status)) {
          throw new CheckInOperationError("REGISTRATION_NOT_ELIGIBLE");
        }
        if (attendee.checkIns[0]) {
          return {
            checkIn: attendee.checkIns[0],
            disposition: "ALREADY_CHECKED_IN" as const,
            checkedIn: true,
          };
        }

        const checkIn = await tx.checkIn.create({
          data: {
            eventId,
            registrationAttendeeId: attendeeId,
            idempotencyKey,
          },
        });
        await tx.auditLog.create({
          data: {
            eventId,
            actorUserId,
            action: "ATTENDEE_CHECKED_IN",
            entityType: "RegistrationAttendee",
            entityId: attendeeId,
            correlationId: crypto.randomUUID(),
            summary: "Checked in an attendee.",
          },
        });
        return {
          checkIn,
          disposition: "CREATED" as const,
          checkedIn: true,
        };
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!retryableTransactionError(error)) throw error;
    }
  }
  throw new CheckInOperationError("CHECK_IN_OPERATION_CONFLICT");
}

export async function undoCheckIn(eventId: string, attendeeId: string, actorUserId: string) {
  const prisma = getPrisma();
  const active = await prisma.checkIn.findFirst({
    where: { eventId, registrationAttendeeId: attendeeId, undoneAt: null },
    orderBy: { checkedInAt: "desc" },
  });
  if (!active) return null;

  return prisma.$transaction(async (tx) => {
    const checkIn = await tx.checkIn.update({
      where: { id: active.id },
      data: { undoneAt: new Date(), undoReason: "Corrected by event staff" },
    });
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: "ATTENDEE_CHECK_IN_UNDONE",
        entityType: "RegistrationAttendee",
        entityId: attendeeId,
        correlationId: crypto.randomUUID(),
        summary: "Undid an attendee check-in.",
      },
    });
    return checkIn;
  });
}
