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
  hasClassRequirements,
  requirementGaps,
  requirementResolution,
  selectionProblem,
  type RequirementWaivers,
  type SelectableOffering,
} from "@/modules/honors/enrollment-domain";
import type { ClubClassLevel } from "@/modules/club-rosters/domain";
import { compareOfferingRows, offeringHonorsSelect, summarizeOfferingHonors } from "@/modules/honors/offering-honors";
import { picksByAttendeeId } from "@/modules/honors/registration-picks";

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

/**
 * Whose seats these are (#650). A club holds seats as its club; a "Group"
 * registration has no club, so it is its own "club" for the per-club limit,
 * counted by its registration. A group is never recorded under an organization.
 */
export type SeatOwner = { kind: "club"; organizationId: string } | { kind: "group"; registrationId: string };

/**
 * What the class rules need to know about roster members (#832): the director-set
 * class level on the roster and which of `honorIds` (the event's prerequisite
 * honors) the member's honor record shows completed. A voided entry doesn't count.
 * Nothing else from the record is read.
 */
async function loadMemberRequirements(client: Prisma.TransactionClient, memberIds: readonly string[], honorIds: readonly string[]) {
  const result = new Map<string, { classLevel: ClubClassLevel | null; completedHonorIds: string[] }>();
  if (memberIds.length === 0) return result;
  const members = await client.clubRosterMember.findMany({
    where: { id: { in: [...memberIds] } },
    select: { id: true, classLevel: true, personId: true },
  });
  const personIds = members.map((member) => member.personId).filter((id): id is string => Boolean(id));
  const entries = honorIds.length > 0 && personIds.length > 0
    ? await client.memberHonorEntry.findMany({
      where: { personId: { in: personIds }, honorId: { in: [...honorIds] }, status: "COMPLETED", void: null },
      select: { personId: true, honorId: true },
    })
    : [];
  for (const member of members) {
    const completed = member.personId ? entries.filter((entry) => entry.personId === member.personId).map((entry) => entry.honorId) : [];
    result.set(member.id, { classLevel: member.classLevel, completedHonorIds: [...new Set(completed)] });
  }
  return result;
}

/** Honors any class of the event requires first (#832). */
async function eventPrerequisiteHonorIds(client: Prisma.TransactionClient, eventId: string) {
  const rows = await client.honorOfferingPrerequisite.findMany({ where: { offering: { eventId } }, select: { honorId: true }, distinct: ["honorId"] });
  return rows.map((row) => row.honorId);
}

const registrationForLoading = {
  id: true,
  status: true,
  locationId: true,
  location: { select: { id: true, name: true } },
  attendees: {
    orderBy: { position: "asc" as const },
    select: { id: true, profileSnapshot: true },
  },
} satisfies Prisma.RegistrationSelect;

const eventForLoading = { id: true, isPublished: true, endsAt: true, timezone: true, registrationOpensOn: true, registrationClosesOn: true, waitlistEnabled: true } satisfies Prisma.EventSelect;

async function loadRegistration(client: Prisma.TransactionClient, owner: SeatOwner, eventId: string) {
  // Class picking works on a club's one registration (#809: an event with several teams per club cannot have classes).
  const clubRegistration = owner.kind === "club"
    ? await client.clubEventRegistration.findUnique({
      where: { eventId_organizationId_teamKey: { eventId, organizationId: owner.organizationId, teamKey: "" } },
      select: { event: { select: eventForLoading }, registration: { select: registrationForLoading } },
    })
    : await client.groupEventRegistration.findFirst({
      where: { eventId, registrationId: owner.registrationId },
      select: { event: { select: eventForLoading }, registration: { select: registrationForLoading } },
    });
  if (!clubRegistration || !["SUBMITTED", "CONFIRMED"].includes(clubRegistration.registration.status)) {
    throw new ClassSelectionError(
      "NOT_REGISTERED",
      owner.kind === "club" ? "Register your club for this event before choosing classes." : "Register your group for this event before choosing classes.",
    );
  }
  const memberIds = clubRegistration.registration.attendees
    .map((attendee) => (attendee.profileSnapshot as Snapshot).clubRosterMemberId)
    .filter((id): id is string => Boolean(id));
  const members = await client.clubRosterMember.findMany({
    where: { id: { in: memberIds } },
    select: { id: true, attendeeType: true },
  });
  const typeByMember = new Map(members.map((member) => [member.id, member.attendeeType]));
  const requirementsByMember = memberIds.length > 0
    ? await loadMemberRequirements(client, memberIds, await eventPrerequisiteHonorIds(client, eventId))
    : new Map<string, { classLevel: ClubClassLevel | null; completedHonorIds: string[] }>();
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
      // Level and honor records come from the roster member; a guest or group person has none (#832).
      classLevel: snapshot.clubRosterMemberId ? requirementsByMember.get(snapshot.clubRosterMemberId)?.classLevel ?? null : null,
      completedHonorIds: snapshot.clubRosterMemberId ? requirementsByMember.get(snapshot.clubRosterMemberId)?.completedHonorIds ?? [] : [],
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
      minimumClassLevel: true,
      prerequisites: { select: { honor: { select: { id: true, name: true } } } },
      perClubLimit: true,
      teacherName: true,
      location: true,
      isActive: true,
      honors: offeringHonorsSelect,
      session: { select: { name: true, sortOrder: true, locationId: true, location: { select: { name: true } } } },
    },
  });
  // By the class's honor names in alphabetical order, so reordering a class's honors never moves it (#812).
  return [...offerings].sort(compareOfferingRows).map((offering) => {
    const taught = summarizeOfferingHonors(offering.honors);
    return {
    // The site comes from the session; an all-sessions class has its own (#589).
    siteId: offeringSiteId(offering),
    siteName: offering.span === "ALL_SESSIONS" ? offering.site?.name ?? null : offering.session?.location?.name ?? null,
    id: offering.id,
    // A class can teach several honors (#812): enrolling is enrolling in each, so the picker names them all.
    honorName: taught.honorName,
    honorCode: taught.honorCode,
    span: offering.span,
    sessionId: offering.sessionId,
    sessionName: offering.session?.name ?? null,
    sessionOrder: offering.session?.sortOrder ?? -1,
    capacity: offering.capacity,
    minimumAge: offering.minimumAge,
    minimumClassLevel: offering.minimumClassLevel,
    // Sorted by name so the picker reads the same every time (#832).
    prerequisiteHonors: offering.prerequisites.map((row) => row.honor).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    perClubLimit: offering.perClubLimit,
    teacherName: offering.teacherName,
    location: offering.location,
    isActive: offering.isActive,
    };
  });
}

/** Seats held by active registrations; a cancelled club registration gives its seats back. */
export const seatHoldingEnrollment = { consumesSeat: true, registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } } } satisfies Prisma.HonorEnrollmentWhereInput;

/** The seats one owner holds, for its per-club limit: a club's, or a group registration's own (#650). */
function ownerSeats(owner: SeatOwner | null): Prisma.HonorEnrollmentWhereInput {
  if (!owner) return { id: { in: [] } };
  return owner.kind === "club" ? { organizationId: owner.organizationId } : { registrationId: owner.registrationId };
}

async function seatCounts(client: Prisma.TransactionClient, eventId: string, owner: SeatOwner | null) {
  const [all, club] = await Promise.all([
    client.honorEnrollment.groupBy({ by: ["offeringId"], where: { eventId, ...seatHoldingEnrollment }, _count: { _all: true } }),
    client.honorEnrollment.groupBy({ by: ["offeringId"], where: { eventId, ...ownerSeats(owner), ...seatHoldingEnrollment }, _count: { _all: true } }),
  ]);
  return {
    taken: new Map(all.map((row) => [row.offeringId, row._count._all])),
    clubTaken: new Map(club.map((row) => [row.offeringId, row._count._all])),
  };
}

/** What the director's class picker needs: who's going, classes with live seats, and current picks. */
export async function getClassSelectionWorkspace(organizationId: string, eventId: string, now = new Date()) {
  return getOwnerClassSelectionWorkspace({ kind: "club", organizationId }, eventId, now);
}

/** A "Group" registration's class picker (#650): the same workspace, for its own registration. */
export async function getGroupClassSelectionWorkspace(registrationId: string, eventId: string, now = new Date()) {
  return getOwnerClassSelectionWorkspace({ kind: "group", registrationId }, eventId, now);
}

async function getOwnerClassSelectionWorkspace(owner: SeatOwner, eventId: string, now: Date) {
  const prisma = getPrisma();
  const registration = await loadRegistration(prisma, owner, eventId);
  const locationId = registration.location?.id ?? null;
  const [allOfferings, counts, enrollments, allSessions] = await Promise.all([
    loadOfferings(prisma, eventId),
    seatCounts(prisma, eventId, owner),
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

/**
 * How a save asks past a class's level or prerequisite-honor rules (#832), keyed
 * by registration attendee id. `confirmations`: the class ids the director
 * confirmed the person meets, for a missing level or honor record. `overrides`:
 * class id to the reason staff placed the person anyway; only staff acting as the
 * director may use them. Both are recorded on the enrollment and audited.
 */
export type RequirementWaiverInput = {
  confirmations?: Record<string, string[]>;
  overrides?: Record<string, Record<string, string>>;
};

export async function setClassSelections(
  organizationId: string,
  eventId: string,
  actor: ClassSelectionActor,
  selections: Record<string, string[]>,
  now = new Date(),
  waivers: RequirementWaiverInput = {},
) {
  return setOwnerClassSelections({ kind: "club", organizationId }, eventId, actor, selections, now, waivers);
}

/**
 * The contact of a "Group" registration changing its class picks (#650). The
 * contact is identified by their registration's private manage link, not an
 * account, so the audit names the registration and the contact's person id.
 */
export type GroupClassActor = { groupContactPersonId: string };

export async function setGroupClassSelections(
  registrationId: string,
  eventId: string,
  actor: GroupClassActor,
  selections: Record<string, string[]>,
  now = new Date(),
) {
  // No director or roster stands behind a group's people, so nobody can confirm a level or honor record for them:
  // a class with a level or prerequisite is open to a group only when the person is shown to meet it (never today),
  // and staff place them from the staff side (#832).
  return setOwnerClassSelections({ kind: "group", registrationId }, eventId, actor, selections, now, {});
}

async function setOwnerClassSelections(
  owner: SeatOwner,
  eventId: string,
  actor: ClassSelectionActor | GroupClassActor,
  selections: Record<string, string[]>,
  now: Date,
  waivers: RequirementWaiverInput,
) {
  const prisma = getPrisma();
  const overridesGiven = Object.values(waivers.overrides ?? {}).some((byClass) => Object.keys(byClass).length > 0);
  if (overridesGiven && !("userId" in actor)) {
    throw new ClassSelectionError("SELECTION_INVALID", "Only staff can place someone who doesn't meet a class requirement.");
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      await prisma.$transaction(async (tx) => {
        const registration = await loadRegistration(tx, owner, eventId);
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

        const toCreate: Array<{ attendeeId: string; offeringId: string; consumesSeat: boolean; levelConfirmed: boolean; prerequisitesConfirmed: boolean; overrideReason: string | null }> = [];
        const toDelete: string[] = [];
        for (const [attendeeId, offeringIds] of Object.entries(selections)) {
          const attendee = attendeesById.get(attendeeId);
          if (!attendee) throw new ClassSelectionError("ATTENDEE_NOT_FOUND", owner.kind === "club" ? "That person isn't on your club's registration." : "That person isn't on your group's registration.");
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
          const attendeeWaivers: RequirementWaivers = {
            confirmed: new Set(waivers.confirmations?.[attendeeId] ?? []),
            overrides: new Map(Object.entries(waivers.overrides?.[attendeeId] ?? {})),
          };
          const problem = selectionProblem(attendee, offeringIds, offeringsById, currentIds, attendeeWaivers);
          if (problem) {
            throw new ClassSelectionError("SELECTION_INVALID", `${attendee.firstName} ${attendee.lastName}: ${problem}`.trim());
          }
          const wanted = new Set(offeringIds);
          toDelete.push(...current.filter((enrollment) => !wanted.has(enrollment.offeringId)).map((enrollment) => enrollment.id));
          for (const offeringId of offeringIds) {
            if (currentIds.has(offeringId)) continue;
            // How the person got past a level or prerequisite rule, if they did, is recorded with the seat (#832).
            const resolution = requirementResolution(attendee, offeringsById.get(offeringId)!, attendeeWaivers);
            toCreate.push({
              attendeeId,
              offeringId,
              consumesSeat: attendee.consumesSeat,
              levelConfirmed: resolution.levelConfirmed,
              prerequisitesConfirmed: resolution.prerequisitesConfirmed,
              overrideReason: resolution.overrideReason,
            });
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
              // A group's seats name no club (#650).
              organizationId: owner.kind === "club" ? owner.organizationId : null,
              consumesSeat: row.consumesSeat,
              levelConfirmedByDirector: row.levelConfirmed,
              prerequisitesConfirmedByDirector: row.prerequisitesConfirmed,
              requirementOverrideReason: row.overrideReason,
              requirementOverriddenByUserId: row.overrideReason && "userId" in actor ? actor.userId : null,
            })),
          });
        }

        const counts = await seatCounts(tx, eventId, owner);
        for (const offeringId of gaining) {
          const offering = offeringsById.get(offeringId)!;
          if ((counts.taken.get(offeringId) ?? 0) > offering.capacity) {
            throw new ClassSelectionError("CLASS_FULL", `${offering.honorName} is full. Choose another class.`);
          }
          if (offering.perClubLimit !== null && (counts.clubTaken.get(offeringId) ?? 0) > offering.perClubLimit) {
            throw new ClassSelectionError(
              "CLUB_LIMIT_REACHED",
              `${offering.honorName} allows ${offering.perClubLimit} youth per ${owner.kind === "club" ? "club" : "group"}.`,
            );
          }
        }

        await writeAuditLog({
          eventId,
          ...("userId" in actor ? { actorUserId: actor.userId } : {}),
          action: "HONOR_CLASSES_UPDATED",
          entityType: "Registration",
          entityId: registration.registrationId,
          summary: owner.kind === "club" ? "A club director updated class choices." : "A group contact updated class choices.",
          metadata: {
            ...(owner.kind === "club" ? { organizationId: owner.organizationId } : { group: true }),
            ...("accountId" in actor
              ? { actorAttendeeAccountId: actor.accountId }
              : "groupContactPersonId" in actor ? { groupContactPersonId: actor.groupContactPersonId } : { actAsId: actor.actAsId }),
            added: toCreate.length,
            removed: toDelete.length,
            people: Object.keys(selections).length,
            // Director confirmations of a missing class level or honor record, by person and class (#832).
            ...(toCreate.some((row) => row.levelConfirmed || row.prerequisitesConfirmed)
              ? {
                requirementsConfirmed: toCreate
                  .filter((row) => row.levelConfirmed || row.prerequisitesConfirmed)
                  .map((row) => ({ registrationAttendeeId: row.attendeeId, offeringId: row.offeringId, level: row.levelConfirmed, prerequisites: row.prerequisitesConfirmed })),
              }
              : {}),
          },
        }, tx);
        // Each placement past a rule by staff gets its own entry with the reason (#832).
        for (const row of toCreate.filter((candidate) => candidate.overrideReason)) {
          await writeAuditLog({
            eventId,
            ...("userId" in actor ? { actorUserId: actor.userId } : {}),
            action: "HONOR_CLASS_REQUIREMENT_OVERRIDDEN",
            entityType: "Registration",
            entityId: registration.registrationId,
            summary: `Staff placed someone in ${offeringsById.get(row.offeringId)!.honorName} without meeting its class level or prerequisite honors: ${row.overrideReason}`,
            metadata: {
              ...(owner.kind === "club" ? { organizationId: owner.organizationId } : { group: true }),
              ...("actAsId" in actor ? { actAsId: actor.actAsId } : {}),
              registrationAttendeeId: row.attendeeId,
              offeringId: row.offeringId,
              reason: row.overrideReason,
              unmet: requirementGaps(attendeesById.get(row.attendeeId)!, offeringsById.get(row.offeringId)!).map((gap) => gap.kind),
            },
          }, tx);
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return getOwnerClassSelectionWorkspace(owner, eventId, now);
    } catch (error) {
      if (!isSerializationFailure(error)) throw error;
      if (attempt === 3) {
        throw new ClassSelectionError("SELECTION_CONFLICT", "Several people were choosing classes at once. Please save again.");
      }
    }
  }
}

/**
 * What the honors step of a club registration needs before anything is
 * saved (#618): every active class with its site and live seats. The screen
 * narrows it to the site the club picks with `offeringsAtLocation`; the
 * server narrows it again on save (`setClassSelections`), so this is guidance.
 */
export async function getRegistrationHonorsCatalog(
  organizationId: string | null,
  eventId: string,
  /**
   * The site, when the server already knows it (a single-site event, or none):
   * only that site's classes, and those with no site, are sent. Left out, every
   * site's classes are sent and the screen narrows them once a site is picked.
   */
  knownLocationId?: string | null,
) {
  const prisma = getPrisma();
  const [offerings, counts, sessions] = await Promise.all([
    loadOfferings(prisma, eventId),
    // A group not yet registered holds no seats, so it has no club count (#650).
    seatCounts(prisma, eventId, organizationId ? { kind: "club", organizationId } : null),
    prisma.honorSession.findMany({
      where: { eventId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { name: "asc" }],
      select: { id: true, name: true, locationId: true, sortOrder: true, createdAt: true },
    }),
  ]);
  const visible = (siteId: string | null) => knownLocationId === undefined || sessionVisibleAtLocation(siteId, knownLocationId);
  // The club's roster levels and completed prerequisite honors, so the registration step can show what a class asks of
  // each person (#832). Only when some class asks anything; the server checks again when the picks are saved.
  const prerequisiteHonorIds = [...new Set(offerings.filter((offering) => offering.isActive).flatMap((offering) => offering.prerequisiteHonors.map((honor) => honor.id)))];
  const anyRequirement = offerings.some((offering) => offering.isActive && hasClassRequirements(offering));
  const memberRequirements: Record<string, { classLevel: ClubClassLevel | null; completedHonorIds: string[] }> = {};
  if (organizationId && anyRequirement) {
    const rosterIds = (await prisma.clubRosterMember.findMany({ where: { organizationId, status: "ACTIVE" }, select: { id: true } })).map((member) => member.id);
    for (const [memberId, value] of await loadMemberRequirements(prisma, rosterIds, prerequisiteHonorIds)) memberRequirements[memberId] = value;
  }
  return {
    memberRequirements,
    sessions: sessions.filter((session) => visible(session.locationId)),
    offerings: offerings
      .filter((offering) => offering.isActive && visible(offering.siteId))
      .map((offering) => ({
        ...offering,
        seatsTaken: counts.taken.get(offering.id) ?? 0,
        clubSeatsTaken: counts.clubTaken.get(offering.id) ?? 0,
      })),
  };
}

/**
 * The class picker's workspace, or null while the club has no seated
 * registration (none yet, waitlisted, or cancelled), so a page can call it for
 * any registration without crashing (#618).
 */
export async function getClassSelectionWorkspaceIfRegistered(organizationId: string, eventId: string, now = new Date()) {
  try {
    return await getClassSelectionWorkspace(organizationId, eventId, now);
  } catch (error) {
    if (error instanceof ClassSelectionError && error.code === "NOT_REGISTERED") return null;
    throw error;
  }
}

export type RegistrationHonorsCatalog = Awaited<ReturnType<typeof getRegistrationHonorsCatalog>>;

/**
 * Saves the honors picked during registration, right after the registration
 * is submitted. The picks arrive keyed by the event form's client ids; they
 * are mapped to the saved attendees and handed to `setClassSelections`, so
 * seats, per-club limits, site, age and one-per-session rules are the same
 * ones every other save uses. Returns how many classes were saved.
 */
export async function saveRegistrationHonorPicks(
  organizationId: string,
  eventId: string,
  actor: ClassSelectionActor,
  picks: Record<string, string[]>,
  now = new Date(),
  /** Classes the director confirmed the person meets, keyed like `picks` (#832). Staff overrides aren't taken at registration. */
  confirmations: Record<string, string[]> = {},
) {
  if (Object.values(picks).every((ids) => ids.length === 0)) return { saved: 0 };
  const prisma = getPrisma();
  const clubRegistration = await prisma.clubEventRegistration.findUnique({
    where: { eventId_organizationId_teamKey: { eventId, organizationId, teamKey: "" } },
    select: { registration: { select: { attendees: { orderBy: { position: "asc" }, select: { id: true, profileSnapshot: true } } } } },
  });
  if (!clubRegistration) throw new ClassSelectionError("NOT_REGISTERED", "Register your club for this event before choosing classes.");
  const { mapped, unknown } = picksByAttendeeId(
    picks,
    clubRegistration.registration.attendees.map((attendee) => {
      const snapshot = attendee.profileSnapshot as { clubRosterMemberId?: string; clubGuestId?: string };
      return { id: attendee.id, clubRosterMemberId: snapshot.clubRosterMemberId ?? null, clubGuestId: snapshot.clubGuestId ?? null };
    }),
  );
  if (unknown.length > 0) throw new ClassSelectionError("ATTENDEE_NOT_FOUND", "That person isn't on your club's registration.");
  const mappedConfirmations = picksByAttendeeId(confirmations, clubRegistration.registration.attendees.map((attendee) => {
    const snapshot = attendee.profileSnapshot as { clubRosterMemberId?: string; clubGuestId?: string };
    return { id: attendee.id, clubRosterMemberId: snapshot.clubRosterMemberId ?? null, clubGuestId: snapshot.clubGuestId ?? null };
  })).mapped;
  await setClassSelections(organizationId, eventId, actor, mapped, now, { confirmations: mappedConfirmations });
  return { saved: Object.values(mapped).reduce((total, ids) => total + ids.length, 0) };
}
