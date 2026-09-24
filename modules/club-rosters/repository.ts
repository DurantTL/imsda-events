import "server-only";

import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { openBirthDate, sealBirthDate } from "@/modules/club-rosters/birth-dates";
import { ageOn, birthDateProblem, calendarDateOf, defaultRosterRole } from "@/modules/club-rosters/domain";
import type { RosterMemberInput, RosterMemberUpdate } from "@/modules/club-rosters/schemas";

/**
 * Club roster storage (#356). Birth dates are sealed on write and opened only
 * to compute ages or for an audited reveal. Audit entries name the club and the
 * roster row, never a person's name or birth date.
 */

export type RosterErrorCode = "MEMBER_NOT_FOUND" | "DUPLICATE_MEMBER" | "BIRTH_DATE_INVALID" | "MEMBER_REMOVED" | "GENDER_REQUIRED";

export class RosterOperationError extends Error {
  constructor(public readonly code: RosterErrorCode, message: string) {
    super(message);
    this.name = "RosterOperationError";
  }
}

type Actor = { accountId: string };

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
    action,
    entityType: "ClubRosterMember",
    entityId,
    summary,
    metadata: { organizationId, actorAttendeeAccountId: actor.accountId, ...metadata },
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
    .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
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
  const memberId = await getPrisma().$transaction(async (tx) => {
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
        createdByAccountId: actor.accountId,
      },
      select: { id: true },
    });
    await audit(tx, actor, "CLUB_ROSTER_MEMBER_ADDED", organizationId, member.id, "Added a person to a club roster.", {
      clubYear,
      attendeeType: input.attendeeType,
      source: options.source ?? "DIRECTOR",
    });
    return member.id;
  });
  return memberId;
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
  await getPrisma().$transaction(async (tx) => {
    const member = await findMember(tx, organizationId, memberId);
    // A details edit from the roster form (#424) must leave the person with a
    // gender, sent or already on file. Marking someone active or inactive
    // doesn't touch their details, so it stays exempt.
    const editsDetails = Object.keys(input).some((field) => field !== "status");
    if (options.requireGender && editsDetails && (input.gender === undefined ? member.gender : input.gender) === null) {
      throw new RosterOperationError("GENDER_REQUIRED", "Choose Male or Female.");
    }
    // A blank role defaults by the type the person ends up with (#424): youth
    // become "Pathfinder", staff and adults stay blank. A typed role is kept.
    const role = input.role === undefined
      ? undefined
      : input.role.trim() || defaultRosterRole(input.attendeeType ?? member.attendeeType);
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
  });
}

/**
 * The club takes someone off its roster: birth date, role, gender, and the
 * person link are erased. The Person record itself is deleted when nothing
 * else (a registration, another roster, an account) still refers to it.
 */
export async function removeRosterMember(organizationId: string, memberId: string, actor: Actor, now = new Date()) {
  await getPrisma().$transaction(async (tx) => {
    const member = await findMember(tx, organizationId, memberId);
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
      },
    });
    let personDeleted = false;
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
            },
          },
        },
      });
      if (person && Object.values(person._count).every((count) => count === 0)) {
        await tx.person.delete({ where: { id: member.personId } });
        personDeleted = true;
      }
    }
    await audit(tx, actor, "CLUB_ROSTER_MEMBER_REMOVED", organizationId, memberId, "Removed a person from a club roster and erased their details.", {
      personDeleted,
    });
  });
}

/** Full birth dates for the roster, for an authorized director. Audited without the dates. */
/** Staff reveal from the "Open club" view (#386) is audited as the staff user. */
export async function revealRosterBirthDates(organizationId: string, clubYear: string, actor: Actor | { userId: string }) {
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
      ...("accountId" in actor ? { actorAttendeeAccountId: actor.accountId } : { viewedAsStaff: true }),
    },
  });
  return birthDates;
}
