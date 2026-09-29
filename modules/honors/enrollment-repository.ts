import "server-only";

import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { evaluateEventRegistrationPhase, hasEventEnded, registrationClosedMessage } from "@/modules/events/lifecycle";
import {
  chooseLocationFirstMessage,
  differentLocationMessage,
  eventHasActiveLocations,
  offeringSiteId,
  sessionVisibleAtLocation,
} from "@/modules/honors/locations";
import {
  consumesClassSeat,
  selectionProblem,
  type SelectableOffering,
} from "@/modules/honors/enrollment-domain";

/**
 * Honors Weekend class seats (#359). Every rule is checked here, inside one
 * serializable transaction that locks the affected classes, so a class can
 * never be overfilled however many directors save at once.
 */

export class ClassSelectionError extends Error {
  constructor(
    public readonly code:
      | "NOT_REGISTERED"
      | "DEADLINE_PASSED"
      | "ATTENDEE_NOT_FOUND"
      | "SELECTION_INVALID"
      | "LOCATION_REQUIRED"
      | "CLASS_FULL"
      | "CLUB_LIMIT_REACHED"
      | "SELECTION_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "ClassSelectionError";
  }
}

type Snapshot = { firstName?: string; lastName?: string; ageOnEventDate?: number | null; clubRosterMemberId?: string; temporaryAttendeeType?: "ADULT" | "YOUTH" };

async function loadClubRegistration(client: Prisma.TransactionClient, organizationId: string, eventId: string) {
  const clubRegistration = await client.clubEventRegistration.findUnique({
    where: { eventId_organizationId: { eventId, organizationId } },
    select: {
      event: { select: { id: true, isPublished: true, endsAt: true, timezone: true, registrationOpensOn: true, registrationClosesOn: true, waitlistEnabled: true } },
      registration: {
        select: {
          id: true,
          status: true,
          locationId: true,
          location: { select: { id: true, name: true } },
          attendees: {
            orderBy: { position: "asc" },
            select: { id: true, profileSnapshot: true },
          },
        },
      },
    },
  });
  if (!clubRegistration || !["SUBMITTED", "CONFIRMED"].includes(clubRegistration.registration.status)) {
    throw new ClassSelectionError("NOT_REGISTERED", "Register your club for this event before choosing classes.");
  }
  const memberIds = clubRegistration.registration.attendees
    .map((attendee) => (attendee.profileSnapshot as Snapshot).clubRosterMemberId)
    .filter((id): id is string => Boolean(id));
  const members = await client.clubRosterMember.findMany({
    where: { id: { in: memberIds } },
    select: { id: true, attendeeType: true },
  });
  const typeByMember = new Map(members.map((member) => [member.id, member.attendeeType]));
  const attendees = clubRegistration.registration.attendees.map((attendee) => {
    const snapshot = attendee.profileSnapshot as Snapshot;
    const attendeeType = snapshot.clubRosterMemberId ? typeByMember.get(snapshot.clubRosterMemberId) ?? null : snapshot.temporaryAttendeeType ?? null;
    return {
      id: attendee.id,
      firstName: snapshot.firstName ?? "",
      lastName: snapshot.lastName ?? "",
      ageOnEventDate: typeof snapshot.ageOnEventDate === "number" ? snapshot.ageOnEventDate : null,
      attendeeType,
      consumesSeat: consumesClassSeat(attendeeType),
    };
  });
  // With active locations on the event, classes are per site, so the club must have picked one (#589).
  const eventHasLocations = await eventHasActiveLocations(client, eventId);
  return {
    event: clubRegistration.event,
    registrationId: clubRegistration.registration.id,
    location: clubRegistration.registration.location,
    locationRequired: eventHasLocations && !clubRegistration.registration.locationId,
    attendees,
  };
}

async function loadOfferings(client: Prisma.TransactionClient, eventId: string) {
  const offerings = await client.honorOffering.findMany({
    where: { eventId },
    select: {
      id: true,
      span: true,
      sessionId: true,
      locationId: true,
      site: { select: { name: true } },
      capacity: true,
      minimumAge: true,
      perClubLimit: true,
      teacherName: true,
      location: true,
      isActive: true,
      honor: { select: { name: true, code: true } },
      session: { select: { name: true, sortOrder: true, locationId: true, location: { select: { name: true } } } },
    },
    orderBy: [{ honor: { name: "asc" } }],
  });
  return offerings.map((offering) => ({
    // The site comes from the session; an all-sessions class has its own (#589).
    siteId: offeringSiteId(offering),
    siteName: offering.span === "ALL_SESSIONS" ? offering.site?.name ?? null : offering.session?.location?.name ?? null,
    id: offering.id,
    honorName: offering.honor.name,
    honorCode: offering.honor.code,
    span: offering.span,
    sessionId: offering.sessionId,
    sessionName: offering.session?.name ?? null,
    sessionOrder: offering.session?.sortOrder ?? -1,
    capacity: offering.capacity,
    minimumAge: offering.minimumAge,
    perClubLimit: offering.perClubLimit,
    teacherName: offering.teacherName,
    location: offering.location,
    isActive: offering.isActive,
  }));
}

/** Seats held by active registrations; a cancelled club registration gives its seats back. */
export const seatHoldingEnrollment = { consumesSeat: true, registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } } } satisfies Prisma.HonorEnrollmentWhereInput;

async function seatCounts(client: Prisma.TransactionClient, eventId: string, organizationId: string) {
  const [all, club] = await Promise.all([
    client.honorEnrollment.groupBy({ by: ["offeringId"], where: { eventId, ...seatHoldingEnrollment }, _count: { _all: true } }),
    client.honorEnrollment.groupBy({ by: ["offeringId"], where: { eventId, organizationId, ...seatHoldingEnrollment }, _count: { _all: true } }),
  ]);
  return {
    taken: new Map(all.map((row) => [row.offeringId, row._count._all])),
    clubTaken: new Map(club.map((row) => [row.offeringId, row._count._all])),
  };
}

/** What the director's class picker needs: who's going, classes with live seats, and current picks. */
export async function getClassSelectionWorkspace(organizationId: string, eventId: string, now = new Date()) {
  const prisma = getPrisma();
  const registration = await loadClubRegistration(prisma, organizationId, eventId);
  const locationId = registration.location?.id ?? null;
  const [allOfferings, counts, enrollments, allSessions] = await Promise.all([
    loadOfferings(prisma, eventId),
    seatCounts(prisma, eventId, organizationId),
    prisma.honorEnrollment.findMany({
      where: { registrationId: registration.registrationId },
      select: { registrationAttendeeId: true, offeringId: true },
    }),
    prisma.honorSession.findMany({ where: { eventId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { name: "asc" }], select: { id: true, name: true, locationId: true, sortOrder: true, createdAt: true } }),
  ]);
  // Directors see only their site's sessions and classes, plus any with no site.
  // Before a site is picked they see none (#589).
  const sessions = registration.locationRequired ? [] : allSessions.filter((session) => sessionVisibleAtLocation(session.locationId, locationId));
  const offerings = registration.locationRequired ? [] : allOfferings.filter((offering) => sessionVisibleAtLocation(offering.siteId, locationId));
  // Picks at a class the club can't see (moved with a member transfer, say) stay out of the picker and out of the save.
  const visibleIds = new Set(offerings.map((offering) => offering.id));
  const selections: Record<string, string[]> = {};
  for (const enrollment of enrollments) {
    if (!visibleIds.has(enrollment.offeringId)) continue;
    (selections[enrollment.registrationAttendeeId] ??= []).push(enrollment.offeringId);
  }
  return {
    open: evaluateEventRegistrationPhase(registration.event, now) === "OPEN",
    registrationClosesOn: registration.event.registrationClosesOn,
    location: registration.location,
    locationRequired: registration.locationRequired,
    locationMessage: registration.locationRequired ? chooseLocationFirstMessage : null,
    sessions,
    attendees: registration.attendees,
    offerings: offerings.map((offering) => ({
      ...offering,
      seatsTaken: counts.taken.get(offering.id) ?? 0,
      clubSeatsTaken: counts.clubTaken.get(offering.id) ?? 0,
    })),
    selections,
  };
}

export type ClassSelectionWorkspace = Awaited<ReturnType<typeof getClassSelectionWorkspace>>;

function isSerializationFailure(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" || error.code === "P2002");
}

/**
 * Replaces the classes for the people in `selections` (others are left as
 * they are). Validates every rule, then takes seats and re-counts inside the
 * transaction; if anything is over, nothing is saved.
 */
/** Never an attendee account credited for a staff action (#442): `userId` (with `actAsId`) for a staff "act as" director. */
export type ClassSelectionActor = { accountId: string } | { userId: string; actAsId: string };

export async function setClassSelections(
  organizationId: string,
  eventId: string,
  actor: ClassSelectionActor,
  selections: Record<string, string[]>,
  now = new Date(),
) {
  const prisma = getPrisma();
  for (let attempt = 0; ; attempt += 1) {
    try {
      await prisma.$transaction(async (tx) => {
        const registration = await loadClubRegistration(tx, organizationId, eventId);
        if (evaluateEventRegistrationPhase(registration.event, now) !== "OPEN") {
          throw new ClassSelectionError(
            "DEADLINE_PASSED",
            hasEventEnded(registration.event, now)
              ? registrationClosedMessage
              : `Class choices closed${registration.event.registrationClosesOn ? ` after ${registration.event.registrationClosesOn}` : ""}.`,
          );
        }
        if (registration.locationRequired) {
          throw new ClassSelectionError("LOCATION_REQUIRED", chooseLocationFirstMessage);
        }
        const attendeesById = new Map(registration.attendees.map((attendee) => [attendee.id, attendee]));
        const allOfferings = await loadOfferings(tx, eventId);
        const registrationLocationId = registration.location?.id ?? null;
        // The server, not the screen, keeps a club to its own site's classes (#589).
        const offerings = allOfferings.filter((offering) => sessionVisibleAtLocation(offering.siteId, registrationLocationId));
        const otherSite = new Map(allOfferings.filter((offering) => !offerings.includes(offering)).map((offering) => [offering.id, offering]));
        const offeringsById = new Map<string, SelectableOffering & (typeof offerings)[number]>(offerings.map((offering) => [offering.id, offering]));
        const existing = await tx.honorEnrollment.findMany({
          where: { registrationId: registration.registrationId },
          select: { id: true, registrationAttendeeId: true, offeringId: true },
        });

        const toCreate: Array<{ attendeeId: string; offeringId: string; consumesSeat: boolean }> = [];
        const toDelete: string[] = [];
        for (const [attendeeId, offeringIds] of Object.entries(selections)) {
          const attendee = attendeesById.get(attendeeId);
          if (!attendee) throw new ClassSelectionError("ATTENDEE_NOT_FOUND", "That person isn't on your club's registration.");
          // Only picks the club can see are replaced; a hidden pick is left as it is.
          const current = existing.filter((enrollment) => enrollment.registrationAttendeeId === attendeeId && offeringsById.has(enrollment.offeringId));
          const currentIds = new Set(current.map((enrollment) => enrollment.offeringId));
          const wrongSite = offeringIds.map((id) => otherSite.get(id)).find(Boolean);
          if (wrongSite) {
            throw new ClassSelectionError(
              "SELECTION_INVALID",
              `${attendee.firstName} ${attendee.lastName}: ${differentLocationMessage(wrongSite.honorName, registration.location?.name ?? null)}`.trim(),
            );
          }
          const problem = selectionProblem(attendee, offeringIds, offeringsById, currentIds);
          if (problem) {
            throw new ClassSelectionError("SELECTION_INVALID", `${attendee.firstName} ${attendee.lastName}: ${problem}`.trim());
          }
          const wanted = new Set(offeringIds);
          toDelete.push(...current.filter((enrollment) => !wanted.has(enrollment.offeringId)).map((enrollment) => enrollment.id));
          for (const offeringId of offeringIds) {
            if (!currentIds.has(offeringId)) toCreate.push({ attendeeId, offeringId, consumesSeat: attendee.consumesSeat });
          }
        }

        const gaining = [...new Set(toCreate.filter((row) => row.consumesSeat).map((row) => row.offeringId))].sort();
        if (gaining.length > 0) {
          // Lock the classes gaining seats, in a fixed order, so concurrent
          // saves for the same class queue up instead of both reading "one left".
          await tx.$queryRaw`SELECT id FROM "HonorOffering" WHERE id IN (${Prisma.join(gaining)}) ORDER BY id FOR UPDATE`;
        }
        if (toDelete.length > 0) await tx.honorEnrollment.deleteMany({ where: { id: { in: toDelete } } });
        if (toCreate.length > 0) {
          await tx.honorEnrollment.createMany({
            data: toCreate.map((row) => ({
              eventId,
              offeringId: row.offeringId,
              registrationId: registration.registrationId,
              registrationAttendeeId: row.attendeeId,
              organizationId,
              consumesSeat: row.consumesSeat,
            })),
          });
        }

        const counts = await seatCounts(tx, eventId, organizationId);
        for (const offeringId of gaining) {
          const offering = offeringsById.get(offeringId)!;
          if ((counts.taken.get(offeringId) ?? 0) > offering.capacity) {
            throw new ClassSelectionError("CLASS_FULL", `${offering.honorName} is full. Choose another class.`);
          }
          if (offering.perClubLimit !== null && (counts.clubTaken.get(offeringId) ?? 0) > offering.perClubLimit) {
            throw new ClassSelectionError(
              "CLUB_LIMIT_REACHED",
              `${offering.honorName} allows ${offering.perClubLimit} youth per club.`,
            );
          }
        }

        await writeAuditLog({
          eventId,
          ...("userId" in actor ? { actorUserId: actor.userId } : {}),
          action: "HONOR_CLASSES_UPDATED",
          entityType: "Registration",
          entityId: registration.registrationId,
          summary: "A club director updated class choices.",
          metadata: {
            organizationId,
            ...("accountId" in actor ? { actorAttendeeAccountId: actor.accountId } : { actAsId: actor.actAsId }),
            added: toCreate.length,
            removed: toDelete.length,
            people: Object.keys(selections).length,
          },
        }, tx);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return getClassSelectionWorkspace(organizationId, eventId, now);
    } catch (error) {
      if (!isSerializationFailure(error)) throw error;
      if (attempt === 3) {
        throw new ClassSelectionError("SELECTION_CONFLICT", "Several people were choosing classes at once. Please save again.");
      }
    }
  }
}
