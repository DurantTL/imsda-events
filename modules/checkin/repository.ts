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

/**
 * #825: with 2-4 devices on one desk, several requests can hit the same
 * attendee (or the same small tables) in the same few milliseconds. Each
 * loser of a serialization or unique-index race retries; the pause keeps
 * them from colliding again in lockstep, and eight attempts leaves room for
 * a four-way race plus unrelated writes.
 */
export const CHECK_IN_MAX_ATTEMPTS = 8;

function retryPause(attempt: number) {
  const milliseconds = 10 * (attempt + 1) + Math.floor(Math.random() * 30);
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type Reader = Pick<Prisma.TransactionClient, "auditLog">;

/**
 * Who recorded the active check-in, by display name, for the friendly
 * "already checked in at 2:04 PM by Dana" message on a second device. The
 * check-in row itself carries no actor, so this reads the audit entry written
 * in the same transaction. Null when there is none (e.g. an imported row).
 */
async function checkedInByName(reader: Reader, eventId: string, attendeeId: string) {
  const entry = await reader.auditLog.findFirst({
    where: {
      eventId,
      action: "ATTENDEE_CHECKED_IN",
      entityType: "RegistrationAttendee",
      entityId: attendeeId,
    },
    orderBy: { createdAt: "desc" },
    select: { actor: { select: { displayName: true } } },
  });
  return entry?.actor?.displayName ?? null;
}

export async function checkInAttendee(
  eventId: string,
  attendeeId: string,
  actorUserId: string,
  idempotencyKey: string,
) {
  const prisma = getPrisma();
  for (let attempt = 0; attempt < CHECK_IN_MAX_ATTEMPTS; attempt += 1) {
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
            checkedInBy: replay.undoneAt === null
              ? await checkedInByName(tx, eventId, attendeeId)
              : null,
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
            checkedInBy: await checkedInByName(tx, eventId, attendeeId),
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
          checkedInBy: null,
        };
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!retryableTransactionError(error)) throw error;
      await retryPause(attempt);
    }
  }
  throw new CheckInOperationError("CHECK_IN_OPERATION_CONFLICT");
}

/**
 * Undoes the attendee's active check-in. The update only matches a row that
 * is still active, so two devices undoing at once (or an undo racing a retry)
 * end with one undo and one audit entry; the other gets null, which the route
 * reports as "nothing to undo". Undo racing a fresh check-in is settled by the
 * one-active-row unique index: whichever commits second sees the other.
 */
export async function undoCheckIn(eventId: string, attendeeId: string, actorUserId: string) {
  const prisma = getPrisma();
  for (let attempt = 0; attempt < CHECK_IN_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const active = await tx.checkIn.findFirst({
          where: { eventId, registrationAttendeeId: attendeeId, undoneAt: null },
          orderBy: { checkedInAt: "desc" },
        });
        if (!active) return null;
        const claimed = await tx.checkIn.updateMany({
          where: { id: active.id, undoneAt: null },
          data: { undoneAt: new Date(), undoReason: "Corrected by event staff" },
        });
        if (claimed.count !== 1) return null;
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
        return tx.checkIn.findUniqueOrThrow({ where: { id: active.id } });
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!retryableTransactionError(error)) throw error;
      await retryPause(attempt);
    }
  }
  throw new CheckInOperationError("CHECK_IN_OPERATION_CONFLICT");
}
