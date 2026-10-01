import "server-only";

import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { lockClubOrders } from "@/modules/club-orders/repository";
import { openBirthDate, sealBirthDate } from "@/modules/club-rosters/birth-dates";
import { ageOn, birthDateProblem, calendarDateOf, defaultRosterRole } from "@/modules/club-rosters/domain";
import type { RosterMemberInput, RosterMemberUpdate } from "@/modules/club-rosters/schemas";

/**
 * Club roster storage (#356). Birth dates are sealed on write and opened only
 * to compute ages or for an audited reveal. Audit entries name the club and the
 * roster row, never a person's name or birth date.
 */

export type RosterErrorCode =
  | "MEMBER_NOT_FOUND"
  | "DUPLICATE_MEMBER"
  | "BIRTH_DATE_INVALID"
  | "MEMBER_REMOVED"
  | "GENDER_REQUIRED";

export class RosterOperationError extends Error {
  constructor(public readonly code: RosterErrorCode, message: string) {
    super(message);
    this.name = "RosterOperationError";
  }
}

/**
 * Who did it, for attribution and audit. `userId` covers both the direct
 * staff "Open club" view (#386, no `actAsId`) and a staff "act as" director
 * (#442, with `actAsId` from the act-as record) — never an attendee account
 * credited for a staff action.
 */
type Actor = { accountId: string } | { userId: string; actAsId?: string };

const memberSelect = {
  id: true,
  organizationId: true,
  clubYear: true,
  personId: true,
  attendeeType: true,
  role: true,
  classLevel: true,
  reportedAge: true,
  gender: true,
  sealedBirthDate: true,
  status: true,
  source: true,
  sourceRegistrationId: true,
  updatedAt: true,
  person: { select: { firstName: true, lastName: true } },
} satisfies Prisma.ClubRosterMemberSelect;

type StoredMember = Prisma.ClubRosterMemberGetPayload<{ select: typeof memberSelect }>;

function ageFrom(member: StoredMember, onDate: string) {
  return member.sealedBirthDate ? ageOn(openBirthDate(member.sealedBirthDate), onDate) : null;
}

function serializeMember(member: StoredMember, today: string) {
  return {
    id: member.id,
    firstName: member.person?.firstName ?? "",
    lastName: member.person?.lastName ?? "",
    attendeeType: member.attendeeType,
    role: member.role,
    classLevel: member.classLevel,
    gender: member.gender,
    status: member.status,
    source: member.source,
    age: ageFrom(member, today),
    /** Imported without a birth date (#376): the form's age, until a birth date is added. */
    reportedAge: member.sealedBirthDate ? null : member.reportedAge,
    birthDateNeeded: !member.sealedBirthDate,
    updatedAt: member.updatedAt.toISOString(),
  };
}

export type RosterMemberRecord = ReturnType<typeof serializeMember>;

function audit(
  tx: Prisma.TransactionClient,
  actor: Actor,
  action: string,
  organizationId: string,
  entityId: string,
  summary: string,
  metadata: Record<string, Prisma.InputJsonValue> = {},
) {
  return writeAuditLog({
    ...("userId" in actor ? { actorUserId: actor.userId } : {}),
    action,
    entityType: "ClubRosterMember",
    entityId,
    summary,
    metadata: {
      organizationId,
      ...("accountId" in actor ? { actorAttendeeAccountId: actor.accountId } : { actAsId: actor.actAsId }),
      ...metadata,
    },
  }, tx);
}

function nameKey(firstName: string, lastName: string) {
  return `${firstName} ${lastName}`.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

/** Everyone on the club's roster for the year except removed rows, sorted by name. */
export async function listRoster(organizationId: string, clubYear: string, now = new Date()) {
  const members = await getPrisma().clubRosterMember.findMany({
    where: { organizationId, clubYear, status: { not: "REMOVED" } },
    select: memberSelect,
  });
  const today = calendarDateOf(now);
  return members
    .map((member) => serializeMember(member, today))
    .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName) || a.id.localeCompare(b.id));
}

/** Ages on a given date (e.g. an event's start) for the roster, computed on the server. */
export async function rosterAgesOn(organizationId: string, clubYear: string, onDate: string) {
  const members = await getPrisma().clubRosterMember.findMany({
    where: { organizationId, clubYear, status: "ACTIVE" },
    select: memberSelect,
  });
  return new Map(members.map((member) => [member.id, ageFrom(member, onDate)]));
}

async function findMember(tx: Prisma.TransactionClient, organizationId: string, memberId: string) {
  const member = await tx.clubRosterMember.findFirst({
    where: { id: memberId, organizationId },
    select: memberSelect,
  });
  if (!member) throw new RosterOperationError("MEMBER_NOT_FOUND", "That person isn't on this roster.");
  if (member.status === "REMOVED") {
    throw new RosterOperationError("MEMBER_REMOVED", "That person was removed from the roster.");
  }
  return member;
}

function assertBirthDate(birthDate: string, now: Date) {
  const problem = birthDateProblem(birthDate, calendarDateOf(now));
  if (problem) throw new RosterOperationError("BIRTH_DATE_INVALID", problem);
}

async function assertNotDuplicate(
  tx: Prisma.TransactionClient,
  organizationId: string,
  clubYear: string,
  firstName: string,
  lastName: string,
  birthDate: string,
  exceptMemberId?: string,
) {
  const key = nameKey(firstName, lastName);
  const others = await tx.clubRosterMember.findMany({
    where: { organizationId, clubYear, status: { not: "REMOVED" }, id: exceptMemberId ? { not: exceptMemberId } : undefined },
    select: memberSelect,
  });
  const duplicate = others.some((member) => member.person
    && nameKey(member.person.firstName, member.person.lastName) === key
    && member.sealedBirthDate
    && openBirthDate(member.sealedBirthDate) === birthDate);
  if (duplicate) {
    throw new RosterOperationError(
      "DUPLICATE_MEMBER",
      "Someone with this name and birth date is already on the roster. Edit or reactivate them instead.",
    );
  }
}

export async function addRosterMember(
  organizationId: string,
  clubYear: string,
  input: RosterMemberInput,
  actor: Actor,
  options: { source?: "DIRECTOR" | "REGISTRATION"; sourceRegistrationId?: string | null; now?: Date } = {},
) {
  const now = options.now ?? new Date();
  assertBirthDate(input.birthDate, now);
  const result = await getPrisma().$transaction(async (tx) => {
    await assertNotDuplicate(tx, organizationId, clubYear, input.firstName, input.lastName, input.birthDate);
    const person = await tx.person.create({
      data: { firstName: input.firstName, lastName: input.lastName },
      select: { id: true },
    });
    const member = await tx.clubRosterMember.create({
      data: {
        organizationId,
        clubYear,
        personId: person.id,
        attendeeType: input.attendeeType,
        role: input.role,
        classLevel: input.classLevel,
        gender: input.gender,
        sealedBirthDate: sealBirthDate(input.birthDate),
        source: options.source ?? "DIRECTOR",
        sourceRegistrationId: options.sourceRegistrationId ?? null,
        ...("accountId" in actor ? { createdByAccountId: actor.accountId } : { createdByUserId: actor.userId }),
      },
      select: { id: true },
    });
    await audit(tx, actor, "CLUB_ROSTER_MEMBER_ADDED", organizationId, member.id, "Added a person to a club roster.", {
      clubYear,
      attendeeType: input.attendeeType,
      source: options.source ?? "DIRECTOR",
    });
    return { memberId: member.id, personId: person.id };
  });
  return result;
}

export async function updateRosterMember(
  organizationId: string,
  memberId: string,
  input: RosterMemberUpdate,
  actor: Actor,
  now = new Date(),
  options: { requireGender?: boolean } = {},
) {
  if (input.birthDate !== undefined) assertBirthDate(input.birthDate, now);
  return getPrisma().$transaction(async (tx) => {
    const member = await findMember(tx, organizationId, memberId);
    // Nothing to change (an older client sending only `willingToDrive`, which
    // the schema strips, or an empty edit): no write, no audit entry.
    if (Object.keys(input).length === 0) return { personId: member.personId };
    // A details edit from the roster form (#424) must leave the person with a
    // gender, sent or already on file. Marking someone active or inactive
    // doesn't touch their details, so it stays exempt.
    const editsDetails = Object.keys(input).some((field) => field !== "status");
    if (options.requireGender && editsDetails && (input.gender === undefined ? member.gender : input.gender) === null) {
      throw new RosterOperationError("GENDER_REQUIRED", "Choose Male or Female.");
    }
    // A blank role defaults by the type the person ends up with (#424): youth
    // become "Pathfinder", staff and adults stay blank. A typed role is kept.
    const finalType = input.attendeeType ?? member.attendeeType;
    let role = input.role === undefined
      ? undefined
      : input.role.trim() || defaultRosterRole(finalType);
    // Changing type carries the old type's default role along ("Pathfinder"
    // for a youth moved to staff). Re-default it, but never a typed role.
    const typeChanged = input.attendeeType !== undefined && input.attendeeType !== member.attendeeType;
    const oldDefault = defaultRosterRole(member.attendeeType);
    const effectiveRole = role ?? member.role ?? "";
    if (typeChanged && oldDefault && effectiveRole === oldDefault) {
      role = defaultRosterRole(finalType);
    }
    const firstName = input.firstName ?? member.person?.firstName ?? "";
    const lastName = input.lastName ?? member.person?.lastName ?? "";
    const birthDate = input.birthDate ?? (member.sealedBirthDate ? openBirthDate(member.sealedBirthDate) : "");
    if (input.firstName !== undefined || input.lastName !== undefined || input.birthDate !== undefined) {
      await assertNotDuplicate(tx, organizationId, member.clubYear, firstName, lastName, birthDate, memberId);
    }
    if ((input.firstName !== undefined || input.lastName !== undefined) && member.personId) {
      await tx.person.update({ where: { id: member.personId }, data: { firstName, lastName } });
    }
    await tx.clubRosterMember.update({
      where: { id: memberId },
      data: {
        ...(input.attendeeType === undefined ? {} : { attendeeType: input.attendeeType }),
        ...(role === undefined ? {} : { role }),
        ...(input.classLevel === undefined ? {} : { classLevel: input.classLevel }),
        ...(input.gender === undefined ? {} : { gender: input.gender }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.birthDate === undefined ? {} : { sealedBirthDate: sealBirthDate(input.birthDate), reportedAge: null }),
      },
    });
    const action = input.status === "INACTIVE" && member.status !== "INACTIVE"
      ? "CLUB_ROSTER_MEMBER_DEACTIVATED"
      : input.status === "ACTIVE" && member.status !== "ACTIVE"
        ? "CLUB_ROSTER_MEMBER_REACTIVATED"
        : "CLUB_ROSTER_MEMBER_UPDATED";
    await audit(tx, actor, action, organizationId, memberId, "Updated a person on a club roster.", {
      fields: Object.keys(input),
    });
    return { personId: member.personId };
  });
}

/**
 * Erases one roster row the way ADR 0005 Addendum A section 6 requires:
 * birth date, gender, role, class, reported age, the person link, and
 * any leftover willing-to-drive flag (unused since #544) all go, and the row is marked removed. Shared by a club
 * removing someone (`removeRosterMember`) and a completed transfer (#489)
 * leaving its sending row behind, so the two can never drift apart. Clearing
 * `personId` also frees the `[organizationId, clubYear, personId]` unique
 * key, which is what lets the same person transfer back later in the year.
 */
export async function eraseRosterRow(tx: Prisma.TransactionClient, memberId: string, now: Date) {
  // A meeting check-off names the member by roster row; it goes with them (#653).
  await tx.clubMeetingAttendance.deleteMany({ where: { rosterMemberId: memberId } });
  // Removing someone erases their Health Record at once, whether or not the
  // feature is switched on (#611, options report section 3), and withdraws any
  // open parent link so it can no longer be used.
  // A record follows the person across club-year roster rows, so every record
  // and open link for this person in this club goes, not only this row's. This
  // runs before `personId` is cleared below.
  const row = await tx.clubRosterMember.findUnique({ where: { id: memberId }, select: { organizationId: true, personId: true } });
  const sameRow = { rosterMemberId: memberId };
  const samePerson = row?.personId ? { organizationId: row.organizationId, rosterMember: { personId: row.personId } } : null;
  await tx.healthRecord.deleteMany({ where: samePerson ? { OR: [sameRow, samePerson] } : sameRow });
  await tx.healthRecordLink.updateMany({
    where: { status: "OPEN", ...(samePerson ? { OR: [sameRow, samePerson] } : sameRow) },
    data: { status: "REVOKED", revokedAt: now, tokenHash: null },
  });
  await tx.clubRosterMember.update({
    where: { id: memberId },
    data: {
      status: "REMOVED",
      removedAt: now,
      sealedBirthDate: null,
      gender: null,
      role: "",
      classLevel: null,
      reportedAge: null,
      personId: null,
      // The column is unused since #544; an erased row never keeps a leftover value.
      willingToDrive: false,
    },
  });
}

/**
 * A transfer record (#489) never keeps a person alive, and keeps no free text
 * about them once they're erased: the typed names, the reason, staff's note,
 * and every note on its history and its registration moves are blanked. The
 * person links fall to null when the Person is deleted (onDelete: SetNull).
 */
async function blankTransferText(tx: Prisma.TransactionClient, personId: string, options: { keepPending?: boolean } = {}) {
  const transfers = await tx.memberTransfer.findMany({
    where: {
      OR: [{ personId }, { pendingPersonId: personId }],
      // A still-pending transfer needs the requested name for the receiving director.
      ...(options.keepPending ? { status: { not: "PENDING" as const } } : {}),
    },
    select: { id: true },
  });
  if (transfers.length === 0) return;
  const transferIds = transfers.map((transfer) => transfer.id);
  await tx.memberTransfer.updateMany({
    where: { id: { in: transferIds } },
    data: { requestedFirstName: "", requestedLastName: "", reason: "", staffNote: "" },
  });
  await tx.memberTransferEvent.updateMany({ where: { transferId: { in: transferIds } }, data: { note: "" } });
  await tx.memberTransferRegistrationMove.updateMany({ where: { transferId: { in: transferIds } }, data: { note: "" } });
}

/**
 * The club takes someone off its roster: birth date, role, gender, and the
 * person link are erased (ADR 0005 Addendum A §6), and the Person record is
 * deleted when nothing else still refers to it.
 *
 * Under the club's order lock (#487, #566) this also:
 *   - cancels the club's not-yet-ordered (`NEEDED`) order needs, audited;
 *   - deletes the club's class completions: that history belongs to the
 *     membership being erased, so it never keeps a Person. This club's honor
 *     entries are deleted only when the Person itself is deleted (the
 *     foreign key stays `onDelete: Restrict`, so no other path drops honor
 *     history silently; a kept Person keeps their honor history).
 *
 * The Person is kept when something outside this membership still needs it: a
 * registration, an account link, another roster or club's records, or an item
 * already ordered, received or awarded. When ordered items are the only
 * reason, the Person's email, phone and non-pending transfer free text are
 * erased and just the name remains, so pick lists and awards can still hand
 * out what was ordered. A registered Person keeps their contact fields:
 * they are registration data that account claiming, dedupe and background
 * check matching rely on. `nameKept` reports that ordered items keep a name.
 */
export async function removeRosterMember(organizationId: string, memberId: string, actor: Actor, now = new Date()): Promise<{ personId: string | null; nameKept: boolean }> {
  return getPrisma().$transaction(async (tx) => {
    // The club's order lock serializes this with placing, receiving or
    // awarding an order and with the order-need sync, so a need can't appear
    // or move to ORDERED between the cancel below and the keep-the-Person
    // check. Only the lock wait is bounded.
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
    await lockClubOrders(tx, organizationId);
    const member = await findMember(tx, organizationId, memberId);
    if (member.personId) {
      await tx.$queryRaw`SELECT "id" FROM "Person" WHERE "id" = ${member.personId} FOR UPDATE`;
    }
    // Both waits are done: a stuck lock gave up fast (55P03 -> 503) above.
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = 0");
    await eraseRosterRow(tx, memberId, now);
    // A need this club has not ordered yet has no reason to outlive the
    // membership (#566). ORDERED, RECEIVED and AWARDED needs are history and stay.
    let ordersCancelled = 0;
    let classCompletionsErased = 0;
    if (member.personId) {
      ordersCancelled = (await tx.clubOrderNeed.deleteMany({
        where: { organizationId, personId: member.personId, status: "NEEDED" },
      })).count;
      if (ordersCancelled > 0) {
        await audit(tx, actor, "CLUB_ORDER_NEEDS_CANCELLED_ON_REMOVAL", organizationId, memberId,
          `Cancelled ${ordersCancelled} not-yet-ordered order need${ordersCancelled === 1 ? "" : "s"} for a person removed from the roster.`,
          { needCount: ordersCancelled });
      }
      classCompletionsErased = (await tx.memberClassCompletion.deleteMany({
        where: { organizationId, personId: member.personId },
      })).count;
    }
    let personDeleted = false;
    let nameKept = false;
    let honorEntriesErased = 0;
    if (member.personId) {
      const person = await tx.person.findUnique({
        where: { id: member.personId },
        select: {
          _count: {
            select: {
              householdMembers: true,
              heldRegistrations: true,
              registrationEvents: true,
              externalIdentities: true,
              notes: true,
              attendeeAccountLinks: true,
              userLinks: true,
              clubRosterMemberships: true,
              // Other clubs' class completions keep the Person (#566): the
              // foreign key is `onDelete: Restrict`.
              memberClassCompletions: true,
            },
          },
        },
      });
      // Items already ordered (any club) and another club's open needs both
      // block deleting the Person (`onDelete: Restrict`).
      const orderedNeeds = await tx.clubOrderNeed.count({ where: { personId: member.personId, status: { not: "NEEDED" } } });
      const openElsewhere = await tx.clubOrderNeed.count({ where: { personId: member.personId, status: "NEEDED" } });
      if (person) {
        const { heldRegistrations, registrationEvents, ...others } = person._count;
        const otherUses = Object.values(others).reduce((sum, count) => sum + count, 0) + openElsewhere;
        if (otherUses === 0 && heldRegistrations === 0 && registrationEvents === 0 && orderedNeeds === 0) {
          await blankTransferText(tx, member.personId);
          const erased = await tx.memberHonorEntry.deleteMany({ where: { personId: member.personId } });
          honorEntriesErased = erased.count;
          await tx.person.delete({ where: { id: member.personId } });
          personDeleted = true;
        } else if (otherUses === 0 && heldRegistrations === 0 && registrationEvents === 0) {
          // Ordered items are the only reason left: erase every personal field
          // but the name (§6), and the free text on settled transfer records.
          await blankTransferText(tx, member.personId, { keepPending: true });
          await tx.person.update({ where: { id: member.personId }, data: { normalizedEmail: null, phone: null } });
        }
        nameKept = !personDeleted && orderedNeeds > 0;
      }
    }
    await audit(tx, actor, "CLUB_ROSTER_MEMBER_REMOVED", organizationId, memberId, "Removed a person from a club roster and erased their details.", {
      personDeleted,
      honorEntriesErased,
      ordersCancelled,
      classCompletionsErased,
      nameKept,
    });
    // The person kept (still registered, on another roster…) is refreshed by the caller (#527).
    return { personId: personDeleted ? null : member.personId, nameKept };
    // The lock wait can take up to 5 s, past Prisma's default 5 s transaction limit.
  }, { timeout: 10_000 });
}

/** Full birth dates for the roster, for an authorized director. Audited without the dates. */
/** Staff reveal from the "Open club" view (#386), or a staff "act as" director (#442), is audited as the staff user. */
export async function revealRosterBirthDates(organizationId: string, clubYear: string, actor: Actor) {
  const members = await getPrisma().clubRosterMember.findMany({
    where: { organizationId, clubYear, status: { not: "REMOVED" }, sealedBirthDate: { not: null } },
    select: { id: true, sealedBirthDate: true },
  });
  const birthDates = Object.fromEntries(members.map((member) => [member.id, openBirthDate(member.sealedBirthDate!)]));
  await writeAuditLog({
    ...("userId" in actor ? { actorUserId: actor.userId } : {}),
    action: "CLUB_ROSTER_BIRTH_DATES_REVEALED",
    entityType: "Organization",
    entityId: organizationId,
    summary: "Showed full birth dates on a club roster.",
    metadata: {
      organizationId,
      clubYear,
      count: members.length,
      ...("accountId" in actor
        ? { actorAttendeeAccountId: actor.accountId }
        : actor.actAsId ? { actAsId: actor.actAsId } : { viewedAsStaff: true }),
    },
  });
  return birthDates;
}
