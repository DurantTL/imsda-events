import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import {
  eventStartDate,
  minorStatusAt,
  personAgeFromAnswers,
  planRegistrationDeclaration,
  reviewKindsFor,
  validateResponsibleAdultChoices,
  type MinorStatus,
  type ResponsibleAdultIssue,
  type ReviewAuthority,
  type ReviewKind,
  type RosterPerson,
} from "@/modules/guardian-authority/domain";

/**
 * Declared guardian authority (#131, narrow slice). Authority is one append-only record per declaration,
 * written only from a registration-form submission or a staff action. Nothing in this file reads household,
 * surname, email, `canManage` or the account holder to create one. A declaration gives no access to health,
 * incident or other registration data: it is a link that lodging and check-in can read, nothing more.
 *
 * Every staff function takes the event the caller was authorized for (MANAGE_REGISTRATION is checked by the
 * route or page) and refuses an attendee, adult or review item that is not on that event. Audit entries carry ids only.
 */

export type GuardianAuthorityErrorCode =
  | "EVENT_NOT_FOUND"
  | "ATTENDEE_NOT_FOUND"
  | "NOT_A_MINOR"
  | "ADULT_INVALID"
  | "NO_CHANGE"
  | "NO_ACTIVE_AUTHORITY"
  | "CONFLICT_NOT_FOUND"
  | "CONFLICT_ALREADY_RESOLVED"
  | "REASON_REQUIRED"
  | "CHOICES_INVALID"
  | "LOCKED_BY_STAFF"
  | "CONCURRENT_CHANGE";

export class GuardianAuthorityError extends Error {
  constructor(
    message: string,
    public readonly code: GuardianAuthorityErrorCode,
    public readonly issues: ResponsibleAdultIssue[] = [],
  ) {
    super(message);
    this.name = "GuardianAuthorityError";
  }
}

type Client = Prisma.TransactionClient | PrismaClient;

const TRANSACTION = { timeout: 30_000, maxWait: 10_000 } as const;
/** Registrations that count: drafts and cancellations are not on the roster. */
const IN_SCOPE_STATUSES = ["SUBMITTED", "CONFIRMED", "WAITLISTED"] as const;

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function lockMinor(tx: Prisma.TransactionClient, eventId: string, minorPersonId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`guardian-authority:${eventId}:${minorPersonId}`}))`;
}

// ---------------------------------------------------------------------------------------------
// Facts about an event's people
// ---------------------------------------------------------------------------------------------

export type EventPerson = {
  attendeeId: string;
  personId: string;
  registrationId: string;
  confirmationCode: string;
  accountHolderPersonId: string;
  name: string;
  status: MinorStatus["status"];
  age: number | null;
};

type EventFacts = {
  event: { id: string; name: string; ageOfMajority: number; startDate: string };
  people: EventPerson[];
  /** The latest ACTIVE declaration per minor person. */
  active: Map<string, ActiveAuthority>;
  openConflicts: OpenConflict[];
};

type ActiveAuthority = ReviewAuthority & {
  registrationId: string;
  declaredAt: Date;
  actorUserId: string | null;
  actorPersonId: string | null;
  declarationReason: string | null;
};

type OpenConflict = {
  id: string;
  minorPersonId: string;
  registrationId: string;
  claimedAdultPersonId: string;
  existingAuthorityId: string;
  declaredAt: Date;
};

function personDisplayName(attendee: { profileSnapshot: unknown; person: { firstName: string; lastName: string } }) {
  const profile = record(attendee.profileSnapshot);
  const first = typeof profile.firstName === "string" ? profile.firstName : attendee.person.firstName;
  const last = typeof profile.lastName === "string" ? profile.lastName : attendee.person.lastName;
  return `${first} ${last}`.trim() || "Attendee";
}

/**
 * Everyone on the event's individual registrations with their minor status at the event's start date, the
 * ACTIVE declarations and the open conflicts. Club and group registrations are left out: their rosters
 * come from the club or the group contact, with their own adults and youth, not from this form.
 */
async function loadEventFacts(client: Client, eventId: string): Promise<EventFacts> {
  const event = await client.event.findUnique({
    where: { id: eventId },
    select: { id: true, name: true, startsAt: true, timezone: true, ageOfMajority: true },
  });
  if (!event) throw new GuardianAuthorityError("That event does not exist.", "EVENT_NOT_FOUND");
  const startDate = eventStartDate(event.startsAt, event.timezone);
  const attendees = await client.registrationAttendee.findMany({
    where: {
      eventId,
      registration: {
        status: { in: [...IN_SCOPE_STATUSES] },
        clubRegistration: { is: null },
        groupRegistration: { is: null },
      },
    },
    select: {
      id: true,
      personId: true,
      registrationId: true,
      profileSnapshot: true,
      formResponses: true,
      person: { select: { firstName: true, lastName: true } },
      registration: { select: { confirmationCode: true, accountHolderPersonId: true } },
    },
    orderBy: [{ registrationId: "asc" }, { position: "asc" }, { id: "asc" }],
  });
  const people: EventPerson[] = attendees.map((attendee) => {
    const status = minorStatusAt(personAgeFromAnswers(record(attendee.formResponses), record(attendee.profileSnapshot)), startDate, event.ageOfMajority);
    return {
      attendeeId: attendee.id,
      personId: attendee.personId,
      registrationId: attendee.registrationId,
      confirmationCode: attendee.registration.confirmationCode,
      accountHolderPersonId: attendee.registration.accountHolderPersonId,
      name: personDisplayName(attendee),
      status: status.status,
      age: status.age,
    };
  });
  const [authorities, conflicts] = await Promise.all([
    client.guardianAuthority.findMany({
      where: { eventId, state: "ACTIVE" },
      select: { id: true, minorPersonId: true, adultPersonId: true, source: true, registrationId: true, declaredAt: true, actorUserId: true, actorPersonId: true, declarationReason: true },
    }),
    client.guardianAuthorityConflict.findMany({
      where: { eventId, state: "OPEN" },
      select: { id: true, minorPersonId: true, registrationId: true, claimedAdultPersonId: true, existingAuthorityId: true, declaredAt: true },
      orderBy: { declaredAt: "asc" },
    }),
  ]);
  return {
    event: { id: event.id, name: event.name, ageOfMajority: event.ageOfMajority, startDate },
    people,
    active: new Map(authorities.map((row) => [row.minorPersonId, {
      id: row.id,
      adultPersonId: row.adultPersonId,
      source: row.source,
      registrationId: row.registrationId,
      declaredAt: row.declaredAt,
      actorUserId: row.actorUserId,
      actorPersonId: row.actorPersonId,
      declarationReason: row.declarationReason,
    }])),
    openConflicts: conflicts,
  };
}

// ---------------------------------------------------------------------------------------------
// Recording a declaration (registration form)
// ---------------------------------------------------------------------------------------------

export type DeclarationInput = { minorPersonId: string; adultPersonId: string | null };

export type DeclarationOutcome = {
  created: number;
  superseded: number;
  unchanged: number;
  /** Claims that went to staff review instead of replacing a declaration. */
  conflicts: number;
  ignored: number;
};

/**
 * Records the registrant's declarations for one registration, inside the caller's transaction. The
 * database refuses a minor or an adult who is not on that registration. A declaration that would replace
 * someone else's (a different registration's, or staff's) becomes a review item instead.
 */
export async function recordRegistrationDeclarations(
  tx: Prisma.TransactionClient,
  input: { eventId: string; registrationId: string; actorPersonId: string | null; declarations: readonly DeclarationInput[] },
): Promise<DeclarationOutcome> {
  const outcome: DeclarationOutcome = { created: 0, superseded: 0, unchanged: 0, conflicts: 0, ignored: 0 };
  for (const declaration of input.declarations) {
    await lockMinor(tx, input.eventId, declaration.minorPersonId);
    const latest = await tx.guardianAuthority.findFirst({
      where: { eventId: input.eventId, minorPersonId: declaration.minorPersonId, state: { in: ["ACTIVE", "REVOKED"] } },
      orderBy: [{ declaredAt: "desc" }, { id: "desc" }],
      select: { id: true, registrationId: true, adultPersonId: true, source: true, state: true },
    });
    const plan = planRegistrationDeclaration(
      latest && (latest.state === "ACTIVE" || latest.state === "REVOKED")
        ? { registrationId: latest.registrationId, adultPersonId: latest.adultPersonId, source: latest.source, state: latest.state }
        : null,
      { registrationId: input.registrationId, adultPersonId: declaration.adultPersonId },
    );
    if (plan.kind === "UNCHANGED") {
      outcome.unchanged += 1;
      continue;
    }
    if (plan.kind === "IGNORE") {
      outcome.ignored += 1;
      continue;
    }
    if (plan.kind === "CONFLICT") {
      if (!latest || declaration.adultPersonId === null) continue;
      const existing = await tx.guardianAuthorityConflict.findFirst({
        where: { eventId: input.eventId, minorPersonId: declaration.minorPersonId, claimedAdultPersonId: declaration.adultPersonId, state: "OPEN" },
        select: { id: true },
      });
      if (!existing) {
        const conflict = await tx.guardianAuthorityConflict.create({
          data: {
            eventId: input.eventId,
            registrationId: input.registrationId,
            minorPersonId: declaration.minorPersonId,
            claimedAdultPersonId: declaration.adultPersonId,
            existingAuthorityId: latest.id,
          },
          select: { id: true },
        });
        await writeAuditLog({
          eventId: input.eventId,
          action: "GUARDIAN_AUTHORITY_CONFLICT_OPENED",
          entityType: "GuardianAuthorityConflict",
          entityId: conflict.id,
          summary: "A second adult claimed a minor who already has a responsible adult; staff review is needed.",
          metadata: {
            eventId: input.eventId,
            registrationId: input.registrationId,
            minorPersonId: declaration.minorPersonId,
            claimedAdultPersonId: declaration.adultPersonId,
            existingAuthorityId: latest.id,
          },
        }, tx);
      }
      outcome.conflicts += 1;
      continue;
    }
    const id = randomUUID();
    let supersededId: string | null = null;
    if (plan.kind === "SUPERSEDE" && latest) {
      const ended = await tx.guardianAuthority.updateMany({
        where: { id: latest.id, state: "ACTIVE" },
        data: { state: "SUPERSEDED", supersededAt: new Date(), supersededById: id },
      });
      if (ended.count === 0) throw new GuardianAuthorityError("Someone else just changed this. Reload and try again.", "CONCURRENT_CHANGE");
      supersededId = latest.id;
    }
    await tx.guardianAuthority.create({
      data: {
        id,
        eventId: input.eventId,
        registrationId: input.registrationId,
        minorPersonId: declaration.minorPersonId,
        adultPersonId: declaration.adultPersonId,
        source: "REGISTRATION_FORM",
        actorPersonId: input.actorPersonId,
      },
    });
    await writeAuditLog({
      eventId: input.eventId,
      action: "GUARDIAN_AUTHORITY_DECLARED",
      entityType: "GuardianAuthority",
      entityId: id,
      summary: declaration.adultPersonId ? "Recorded a responsible adult for a minor on the registration form." : "Recorded that a minor has no responsible adult on the registration (None of us).",
      metadata: {
        eventId: input.eventId,
        registrationId: input.registrationId,
        minorPersonId: declaration.minorPersonId,
        adultPersonId: declaration.adultPersonId,
        source: "REGISTRATION_FORM",
        supersededAuthorityId: supersededId,
      },
    }, tx);
    if (supersededId) outcome.superseded += 1;
    else outcome.created += 1;
  }
  return outcome;
}

// ---------------------------------------------------------------------------------------------
// A saved registration: the manage-link edit
// ---------------------------------------------------------------------------------------------

export type RegistrationMinorView = {
  attendeeId: string;
  name: string;
  /** The attendee id of the chosen adult on this registration, "NONE" for "None of us", or null when nothing is recorded. */
  choice: string | null;
  /** True when staff decided (set or revoked): the registrant sees it but cannot change it. */
  lockedByStaff: boolean;
};

export type RegistrationResponsibleAdultView = {
  adults: Array<{ attendeeId: string; name: string; isAccountHolder: boolean }>;
  minors: RegistrationMinorView[];
};

async function loadRegistrationPeople(client: Client, registrationId: string) {
  const registration = await client.registration.findUnique({
    where: { id: registrationId },
    select: {
      id: true,
      eventId: true,
      accountHolderPersonId: true,
      status: true,
      clubRegistration: { select: { id: true } },
      groupRegistration: { select: { id: true } },
      event: { select: { startsAt: true, timezone: true, ageOfMajority: true } },
      attendees: {
        orderBy: [{ position: "asc" }, { id: "asc" }],
        select: { id: true, personId: true, profileSnapshot: true, formResponses: true, person: { select: { firstName: true, lastName: true } } },
      },
    },
  });
  if (!registration) return null;
  const startDate = eventStartDate(registration.event.startsAt, registration.event.timezone);
  const people = registration.attendees.map((attendee) => {
    const status = minorStatusAt(personAgeFromAnswers(record(attendee.formResponses), record(attendee.profileSnapshot)), startDate, registration.event.ageOfMajority);
    return {
      attendeeId: attendee.id,
      personId: attendee.personId,
      name: personDisplayName(attendee),
      status: status.status,
      isAccountHolder: attendee.personId === registration.accountHolderPersonId,
    };
  });
  return { registration, people };
}

type LatestRecord = { minorPersonId: string; adultPersonId: string | null; source: "REGISTRATION_FORM" | "STAFF"; state: "ACTIVE" | "REVOKED"; registrationId: string };

/** The most recent ACTIVE or REVOKED record for each person, if any. */
async function latestRecordsByMinor(client: Client, eventId: string, personIds: readonly string[]) {
  const rows = await client.guardianAuthority.findMany({
    where: { eventId, minorPersonId: { in: [...personIds] }, state: { in: ["ACTIVE", "REVOKED"] } },
    orderBy: [{ declaredAt: "desc" }, { id: "desc" }],
    select: { minorPersonId: true, adultPersonId: true, source: true, state: true, registrationId: true },
  });
  const latest = new Map<string, LatestRecord>();
  for (const row of rows) {
    if (!latest.has(row.minorPersonId) && (row.state === "ACTIVE" || row.state === "REVOKED")) latest.set(row.minorPersonId, { ...row, state: row.state });
  }
  return latest;
}

/** Staff decided it (set or revoked), or another registration holds it: the registrant cannot change it from here. */
function lockedForRegistrant(latest: LatestRecord | undefined, registrationId: string) {
  return Boolean(latest && (latest.state === "REVOKED" || latest.source === "STAFF" || latest.registrationId !== registrationId));
}

/** What the registrant sees on their private page: the minors on the registration and their current choice. Null when there is nothing to choose. */
export async function getRegistrationResponsibleAdultView(registrationId: string, client: Client = getPrisma()): Promise<RegistrationResponsibleAdultView | null> {
  const loaded = await loadRegistrationPeople(client, registrationId);
  if (!loaded || loaded.registration.clubRegistration || loaded.registration.groupRegistration) return null;
  const minors = loaded.people.filter((person) => person.status === "MINOR");
  if (minors.length === 0) return null;
  const latestByMinor = await latestRecordsByMinor(client, loaded.registration.eventId, minors.map((minor) => minor.personId));
  const attendeeByPerson = new Map(loaded.people.map((person) => [person.personId, person.attendeeId]));
  return {
    adults: loaded.people.filter((person) => person.status === "ADULT").map((person) => ({ attendeeId: person.attendeeId, name: person.name, isAccountHolder: person.isAccountHolder })),
    minors: minors.map((minor) => {
      const latest = latestByMinor.get(minor.personId);
      return {
        attendeeId: minor.attendeeId,
        name: minor.name,
        choice: latest && latest.state === "ACTIVE"
          ? latest.adultPersonId === null ? "NONE" : attendeeByPerson.get(latest.adultPersonId) ?? null
          : null,
        lockedByStaff: lockedForRegistrant(latest, loaded.registration.id),
      };
    }),
  };
}

/**
 * The registrant changes who is responsible for their minors (the private manage page). Same validation
 * as the registration form: one choice per minor, "None of us" or an adult on this registration. A minor whose
 * record staff decided, or another registration holds, is left alone (it is not asked for and not changed).
 */
export async function declareResponsibleAdultsForRegistration(
  tx: Prisma.TransactionClient,
  input: { registrationId: string; choices: Readonly<Record<string, string>> },
): Promise<DeclarationOutcome> {
  const loaded = await loadRegistrationPeople(tx, input.registrationId);
  if (!loaded || loaded.registration.clubRegistration || loaded.registration.groupRegistration) {
    throw new GuardianAuthorityError("This registration has no responsible-adult choices.", "ATTENDEE_NOT_FOUND");
  }
  const minorPersonIds = loaded.people.filter((person) => person.status === "MINOR").map((person) => person.personId);
  const latestByMinor = await latestRecordsByMinor(tx, loaded.registration.eventId, minorPersonIds);
  const roster: RosterPerson[] = loaded.people.map((person) => ({
    key: person.attendeeId,
    name: person.name,
    // A locked minor is neither asked for nor an adult option: UNKNOWN is both "not a minor" and "not an adult" here.
    status: person.status === "MINOR" && lockedForRegistrant(latestByMinor.get(person.personId), loaded.registration.id) ? "UNKNOWN" : person.status,
    isAccountHolder: person.isAccountHolder,
  }));
  const { issues, declarations } = validateResponsibleAdultChoices(roster, input.choices);
  if (issues.length > 0) throw new GuardianAuthorityError(issues[0]!.message, "CHOICES_INVALID", issues);
  const personByAttendee = new Map(loaded.people.map((person) => [person.attendeeId, person.personId]));
  return recordRegistrationDeclarations(tx, {
    eventId: loaded.registration.eventId,
    registrationId: loaded.registration.id,
    actorPersonId: loaded.registration.accountHolderPersonId,
    declarations: declarations.map((declaration) => ({
      minorPersonId: personByAttendee.get(declaration.minorKey)!,
      adultPersonId: declaration.adultKey ? personByAttendee.get(declaration.adultKey)! : null,
    })),
  });
}

// ---------------------------------------------------------------------------------------------
// Staff review
// ---------------------------------------------------------------------------------------------

export type ReviewConflictView = {
  id: string;
  claimedAdultName: string;
  claimedAdultPersonId: string;
  claimingConfirmationCode: string;
  declaredAt: string;
};

export type ResponsibleAdultView = {
  personId: string;
  name: string;
  source: "REGISTRATION_FORM" | "STAFF";
  declaredAt: string;
  confirmationCode: string | null;
};

export type GuardianReviewItem = {
  attendeeId: string;
  personId: string;
  registrationId: string;
  confirmationCode: string;
  name: string;
  age: number | null;
  status: MinorStatus["status"];
  kinds: ReviewKind[];
  responsibleAdult: ResponsibleAdultView | null;
  /** True when "None of us" is the ACTIVE declaration. */
  noneOfUs: boolean;
  conflicts: ReviewConflictView[];
};

export type GuardianReview = {
  event: EventFacts["event"];
  items: GuardianReviewItem[];
  /** Every minor (known or unknown) with where they stand, for the full list. */
  minors: GuardianReviewItem[];
  /** Adults staff can name, anywhere on the event's registrations. */
  adults: Array<{ personId: string; name: string; confirmationCode: string }>;
  counts: Record<ReviewKind, number>;
};

const emptyCounts = (): Record<ReviewKind, number> => ({
  NONE_OF_US: 0,
  NO_ADULT_ON_REGISTRATION: 0,
  UNKNOWN_AGE: 0,
  NOT_DECLARED: 0,
  ADULT_LEFT_REGISTRATION: 0,
  CONFLICT: 0,
});

function buildReview(facts: EventFacts): GuardianReview {
  const byRegistration = new Map<string, EventPerson[]>();
  for (const person of facts.people) {
    const list = byRegistration.get(person.registrationId) ?? [];
    list.push(person);
    byRegistration.set(person.registrationId, list);
  }
  const personName = new Map<string, EventPerson>();
  for (const person of facts.people) if (!personName.has(person.personId)) personName.set(person.personId, person);
  const conflictsByMinor = new Map<string, OpenConflict[]>();
  for (const conflict of facts.openConflicts) {
    const list = conflictsByMinor.get(conflict.minorPersonId) ?? [];
    list.push(conflict);
    conflictsByMinor.set(conflict.minorPersonId, list);
  }
  const codeByRegistration = new Map(facts.people.map((person) => [person.registrationId, person.confirmationCode]));
  const counts = emptyCounts();
  const minors: GuardianReviewItem[] = [];
  for (const person of facts.people) {
    if (person.status === "ADULT") continue;
    const siblings = byRegistration.get(person.registrationId) ?? [];
    const authority = facts.active.get(person.personId) ?? null;
    const conflicts = conflictsByMinor.get(person.personId) ?? [];
    const kinds = reviewKindsFor({
      attendeeId: person.attendeeId,
      personId: person.personId,
      registrationId: person.registrationId,
      status: person.status,
      registrationAdultPersonIds: siblings.filter((sibling) => sibling.status === "ADULT").map((sibling) => sibling.personId),
      registrationPersonIds: siblings.map((sibling) => sibling.personId),
      authority,
      openConflictIds: conflicts.map((conflict) => conflict.id),
    });
    for (const kind of kinds) counts[kind] += 1;
    const adult = authority?.adultPersonId ? personName.get(authority.adultPersonId) : null;
    minors.push({
      attendeeId: person.attendeeId,
      personId: person.personId,
      registrationId: person.registrationId,
      confirmationCode: person.confirmationCode,
      name: person.name,
      age: person.age,
      status: person.status,
      kinds,
      responsibleAdult: authority?.adultPersonId
        ? {
            personId: authority.adultPersonId,
            name: adult?.name ?? "Adult no longer on a registration",
            source: authority.source,
            declaredAt: authority.declaredAt.toISOString(),
            confirmationCode: adult?.confirmationCode ?? null,
          }
        : null,
      noneOfUs: Boolean(authority && authority.adultPersonId === null),
      conflicts: conflicts.map((conflict) => ({
        id: conflict.id,
        claimedAdultPersonId: conflict.claimedAdultPersonId,
        claimedAdultName: personName.get(conflict.claimedAdultPersonId)?.name ?? "Adult no longer on a registration",
        claimingConfirmationCode: codeByRegistration.get(conflict.registrationId) ?? "",
        declaredAt: conflict.declaredAt.toISOString(),
      })),
    });
  }
  const sortKey = (item: GuardianReviewItem) => `${item.confirmationCode}\u0000${item.name}`;
  minors.sort((left, right) => sortKey(left).localeCompare(sortKey(right)));
  const seenAdults = new Set<string>();
  const adults: GuardianReview["adults"] = [];
  for (const person of facts.people) {
    if (person.status !== "ADULT" || seenAdults.has(person.personId)) continue;
    seenAdults.add(person.personId);
    adults.push({ personId: person.personId, name: person.name, confirmationCode: person.confirmationCode });
  }
  adults.sort((left, right) => left.name.localeCompare(right.name));
  return { event: facts.event, items: minors.filter((item) => item.kinds.length > 0), minors, adults, counts };
}

/** The staff review for one event. */
export async function getGuardianReview(eventId: string, client: Client = getPrisma()): Promise<GuardianReview> {
  return buildReview(await loadEventFacts(client, eventId));
}

/**
 * Who is responsible for each minor on the event, by attendee id, for the people views and exports. A minor with
 * no active adult is absent from the map. Pure read; it opens no data about the minor.
 */
export async function getResponsibleAdultsByAttendee(eventId: string, client: Client = getPrisma()) {
  const review = await getGuardianReview(eventId, client);
  return new Map(review.minors.map((minor) => [minor.attendeeId, minor] as const));
}

export type ResponsibleAdultExportRow = {
  confirmationCode: string;
  minorName: string;
  minorAge: number | null;
  minorStatus: MinorStatus["status"];
  responsibleAdult: string;
  adultConfirmationCode: string;
  state: string;
};

/** One row per minor or person of unknown age, for the staff CSV; the text is escaped by the CSV writer. */
export async function getResponsibleAdultExportRows(eventId: string, client: Client = getPrisma()): Promise<ResponsibleAdultExportRow[]> {
  const review = await getGuardianReview(eventId, client);
  return review.minors.map((minor) => ({
    confirmationCode: minor.confirmationCode,
    minorName: minor.name,
    minorAge: minor.age,
    minorStatus: minor.status,
    responsibleAdult: minor.responsibleAdult?.name ?? "",
    adultConfirmationCode: minor.responsibleAdult?.confirmationCode ?? "",
    state: minor.responsibleAdult ? "Recorded" : minor.noneOfUs ? "None of us" : "Not recorded",
  }));
}

// ---------------------------------------------------------------------------------------------
// Staff actions
// ---------------------------------------------------------------------------------------------

function requireReason(reason: string) {
  const text = reason.trim();
  if (!text) throw new GuardianAuthorityError("Say why you are changing the responsible adult.", "REASON_REQUIRED");
  return text;
}

async function resolveOpenConflicts(tx: Prisma.TransactionClient, input: { eventId: string; minorPersonId: string; reason: string; actorUserId: string }) {
  const open = await tx.guardianAuthorityConflict.findMany({
    where: { eventId: input.eventId, minorPersonId: input.minorPersonId, state: "OPEN" },
    select: { id: true },
  });
  if (open.length === 0) return [];
  await tx.guardianAuthorityConflict.updateMany({
    where: { id: { in: open.map((conflict) => conflict.id) }, state: "OPEN" },
    data: { state: "RESOLVED", resolvedAt: new Date(), resolvedByUserId: input.actorUserId, resolutionReason: input.reason },
  });
  return open.map((conflict) => conflict.id);
}

function requireMinorOnEvent(facts: EventFacts, attendeeId: string) {
  const target = facts.people.find((person) => person.attendeeId === attendeeId);
  if (!target) throw new GuardianAuthorityError("That person is not on this event.", "ATTENDEE_NOT_FOUND");
  return target;
}

/**
 * Staff set or change the responsible adult of one minor (or person of unknown age). The adult must be an
 * adult at the event start and registered for this event. A change supersedes the earlier record, which is kept.
 */
export async function setResponsibleAdult(input: { eventId: string; attendeeId: string; adultPersonId: string; reason: string; actorUserId: string }) {
  const reason = requireReason(input.reason);
  try {
    return await getPrisma().$transaction(async (tx) => {
      const facts = await loadEventFacts(tx, input.eventId);
      const target = requireMinorOnEvent(facts, input.attendeeId);
      if (target.status === "ADULT") throw new GuardianAuthorityError("That person is an adult at this event.", "NOT_A_MINOR");
      const adult = facts.people.find((person) => person.personId === input.adultPersonId && person.status === "ADULT");
      if (!adult || adult.personId === target.personId) {
        throw new GuardianAuthorityError("Choose an adult who is registered for this event.", "ADULT_INVALID");
      }
      await lockMinor(tx, input.eventId, target.personId);
      const active = await tx.guardianAuthority.findFirst({
        where: { eventId: input.eventId, minorPersonId: target.personId, state: "ACTIVE" },
        select: { id: true, adultPersonId: true },
      });
      if (active && active.adultPersonId === adult.personId) {
        throw new GuardianAuthorityError("That adult is already the responsible adult.", "NO_CHANGE");
      }
      const id = randomUUID();
      if (active) {
        const ended = await tx.guardianAuthority.updateMany({
          where: { id: active.id, state: "ACTIVE" },
          data: { state: "SUPERSEDED", supersededAt: new Date(), supersededById: id },
        });
        if (ended.count === 0) throw new GuardianAuthorityError("Someone else just changed this. Reload and try again.", "CONCURRENT_CHANGE");
      }
      await tx.guardianAuthority.create({
        data: {
          id,
          eventId: input.eventId,
          registrationId: target.registrationId,
          minorPersonId: target.personId,
          adultPersonId: adult.personId,
          source: "STAFF",
          declarationReason: reason,
          actorUserId: input.actorUserId,
        },
      });
      const resolved = await resolveOpenConflicts(tx, { eventId: input.eventId, minorPersonId: target.personId, reason, actorUserId: input.actorUserId });
      await writeAuditLog({
        eventId: input.eventId,
        actorUserId: input.actorUserId,
        action: active ? "GUARDIAN_AUTHORITY_CHANGED_BY_STAFF" : "GUARDIAN_AUTHORITY_SET_BY_STAFF",
        entityType: "GuardianAuthority",
        entityId: id,
        summary: "Staff set the responsible adult for a minor.",
        metadata: {
          eventId: input.eventId,
          registrationId: target.registrationId,
          minorPersonId: target.personId,
          adultPersonId: adult.personId,
          supersededAuthorityId: active?.id ?? null,
          resolvedConflictIds: resolved,
        },
      }, tx);
      return { authorityId: id, supersededAuthorityId: active?.id ?? null, resolvedConflictIds: resolved };
    }, TRANSACTION);
  } catch (error) {
    if (isUniqueViolation(error)) throw new GuardianAuthorityError("Someone else just changed this. Reload and try again.", "CONCURRENT_CHANGE");
    throw error;
  }
}

/**
 * Staff revoke the responsible adult of one minor. It takes effect at once: the record stops being ACTIVE in the
 * same transaction, so nothing can read it as current afterwards, and it is kept as history with who and why.
 */
export async function revokeResponsibleAdult(input: { eventId: string; attendeeId: string; reason: string; actorUserId: string }) {
  const reason = requireReason(input.reason);
  return getPrisma().$transaction(async (tx) => {
    const facts = await loadEventFacts(tx, input.eventId);
    const target = requireMinorOnEvent(facts, input.attendeeId);
    await lockMinor(tx, input.eventId, target.personId);
    const active = await tx.guardianAuthority.findFirst({
      where: { eventId: input.eventId, minorPersonId: target.personId, state: "ACTIVE" },
      select: { id: true },
    });
    if (!active) throw new GuardianAuthorityError("There is no recorded responsible adult to revoke.", "NO_ACTIVE_AUTHORITY");
    const revoked = await tx.guardianAuthority.updateMany({
      where: { id: active.id, state: "ACTIVE" },
      data: { state: "REVOKED", revokedAt: new Date(), revokedByUserId: input.actorUserId, revocationReason: reason },
    });
    if (revoked.count === 0) throw new GuardianAuthorityError("Someone else just changed this. Reload and try again.", "CONCURRENT_CHANGE");
    await writeAuditLog({
      eventId: input.eventId,
      actorUserId: input.actorUserId,
      action: "GUARDIAN_AUTHORITY_REVOKED",
      entityType: "GuardianAuthority",
      entityId: active.id,
      summary: "Staff revoked the responsible adult for a minor.",
      metadata: { eventId: input.eventId, registrationId: target.registrationId, minorPersonId: target.personId, authorityId: active.id },
    }, tx);
    return { authorityId: active.id };
  }, TRANSACTION);
}

/** Staff close a conflict review item, keeping the current responsible adult as it is. */
export async function dismissConflict(input: { eventId: string; conflictId: string; reason: string; actorUserId: string }) {
  const reason = requireReason(input.reason);
  return getPrisma().$transaction(async (tx) => {
    const conflict = await tx.guardianAuthorityConflict.findFirst({
      where: { id: input.conflictId, eventId: input.eventId },
      select: { id: true, state: true, minorPersonId: true, claimedAdultPersonId: true, registrationId: true },
    });
    if (!conflict) throw new GuardianAuthorityError("That review item is not on this event.", "CONFLICT_NOT_FOUND");
    if (conflict.state !== "OPEN") throw new GuardianAuthorityError("That review item is already resolved.", "CONFLICT_ALREADY_RESOLVED");
    const closed = await tx.guardianAuthorityConflict.updateMany({
      where: { id: conflict.id, state: "OPEN" },
      data: { state: "RESOLVED", resolvedAt: new Date(), resolvedByUserId: input.actorUserId, resolutionReason: reason },
    });
    if (closed.count === 0) throw new GuardianAuthorityError("That review item is already resolved.", "CONFLICT_ALREADY_RESOLVED");
    await writeAuditLog({
      eventId: input.eventId,
      actorUserId: input.actorUserId,
      action: "GUARDIAN_AUTHORITY_CONFLICT_DISMISSED",
      entityType: "GuardianAuthorityConflict",
      entityId: conflict.id,
      summary: "Staff closed a conflicting responsible-adult claim without changing the current adult.",
      metadata: { eventId: input.eventId, registrationId: conflict.registrationId, minorPersonId: conflict.minorPersonId, claimedAdultPersonId: conflict.claimedAdultPersonId },
    }, tx);
    return { conflictId: conflict.id };
  }, TRANSACTION);
}
