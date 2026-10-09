import "server-only";

import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { logError, logInfo } from "@/lib/logger";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { openBirthDate, sealBirthDate } from "@/modules/club-rosters/birth-dates";
import { ageOn, clubYearChoices, clubYearFor } from "@/modules/club-rosters/domain";
import { SPONSOR_ORGANIZATION_TYPES } from "@/modules/organizations/domain";
import type { ClubCapabilities } from "@/modules/organizations/director-grants-domain";
import { activeRegistrationStatuses, calendarDateInEventTimeZone } from "@/modules/events/lifecycle";
import { BackgroundCheckOperationError } from "@/modules/background-checks/errors";
import { directorMatchKey, nameWords } from "@/modules/background-checks/director-match";
import { describeIssues } from "@/modules/background-checks/issues";
import {
  ageFromAnswer,
  attendeeIsAdult,
  backgroundCheckState,
  clubComplianceState,
  ADULT_AGE,
  dedupeListRows,
  firstNameVariant,
  isRememberedIdentityKey,
  lookupNameSplits,
  matchableName,
  directorySiteStems,
  matchesSite,
  normalizeCheckDate,
  type BackgroundCheckListRow,
  type BackgroundCheckState,
  type ClubComplianceState,
  type BackgroundComplianceStatus,
} from "@/modules/background-checks/domain";

/**
 * Sterling Volunteers (#388, #427, #527): one stored list, fed by either CSV
 * format, replaced wholesale on every upload. Matching a person to a list
 * entry happens at lookup:
 *
 * - The `BackgroundCheckMatch` cache is filled by the full pass on upload,
 *   by `refreshBackgroundCheckMatches` after any write that adds or edits a
 *   person (best effort, see `refresh-after-write.ts`), and by staff.
 * - Every read path also matches, at read time, anyone the cache has no
 *   match for yet (`lookupUncachedChecks`): one indexed query per page, so a
 *   person added by any write path is matched even before the cache fills.
 *
 * `MANUAL` (a staff decision) and `MIGRATED` (carried over by the #527
 * migration) matches are never recomputed — a refresh can't reproduce them,
 * so it never deletes them. Flags only: registration and check-in never wait
 * on a check.
 */

const ROSTER_IMPORT_PROVIDER = "ROSTER_IMPORT";
type PrismaLike = PrismaClient | Prisma.TransactionClient;

/**
 * Serializes list uploads against each other and against refreshes (#527
 * N1): an upload takes it exclusively, a refresh shared, so two confirms
 * can't interleave and a refresh never writes a match to an entry an upload
 * is deleting.
 */
export const BACKGROUND_CHECK_LOCK_KEY = 5_270_527;

/** Matches a refresh can recompute from the list and the people on file. */
const DERIVED_SOURCES = ["AUTO", "IDENTITY", "NAME_ONLY"] as const;
/** Matches a refresh can't reproduce, so it never touches them. */
const LOCKED_SOURCES = new Set(["MANUAL", "MIGRATED"]);

function openEntryBirthDate(sealed: string | null) {
  if (!sealed) return null;
  try {
    return openBirthDate(sealed);
  } catch {
    return null;
  }
}

async function latestUpload(prisma: PrismaLike) {
  return prisma.backgroundCheckUpload.findFirst({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, createdAt: true } });
}

/**
 * Fills in `normalizedName` for entries the #527 migration carried over
 * (#527 B3): names are only ever normalized here, in TypeScript, never
 * approximated in SQL. One bounded statement; a no-op once filled.
 */
async function backfillNormalizedNames(tx: PrismaLike) {
  const missing = await tx.backgroundCheckEntry.findMany({
    where: { normalizedName: null },
    select: { id: true, firstName: true, lastName: true },
  });
  if (missing.length === 0) return 0;
  const ids = missing.map((entry) => entry.id);
  const names = missing.map((entry) => matchableName(`${entry.firstName} ${entry.lastName}`));
  await tx.$executeRaw`
    UPDATE "BackgroundCheckEntry" AS e
    SET "normalizedName" = v.name
    FROM unnest(${ids}::text[], ${names}::text[]) AS v(id, name)
    WHERE e."id" = v.id AND e."normalizedName" IS NULL
  `;
  return missing.length;
}

// --- Upload: preview (counts) and apply (replace the list) ---

export type BackgroundCheckUploadCounts = { added: number; changed: number; dropped: number; total: number };
export type BackgroundCheckUploadPreview = BackgroundCheckUploadCounts & {
  fingerprint: string;
  /**
   * The list on file is still the one the #527 migration carried over. Those
   * entries have no email or site, so a Sterling file can't recognize them:
   * its first upload shows them as dropped and its rows as added (#527 N6).
   */
  replacesMigratedList: boolean;
};

type StoredEntryFields = {
  identityKey: string;
  firstName: string;
  lastName: string;
  email: string | null;
  sealedBirthDate: string | null;
  site: string | null;
  sourceUserId: string | null;
  complianceStatus: BackgroundComplianceStatus | null;
  checkedOn: string | null;
  expiresOn: string | null;
  issuesNote: string | null;
};

const storedEntrySelect = {
  identityKey: true, firstName: true, lastName: true, email: true, sealedBirthDate: true,
  site: true, sourceUserId: true, complianceStatus: true, checkedOn: true, expiresOn: true, issuesNote: true,
} as const;

async function entriesOfUpload(prisma: PrismaLike, uploadId: string | null): Promise<StoredEntryFields[]> {
  if (!uploadId) return [];
  return prisma.backgroundCheckEntry.findMany({ where: { uploadId }, select: storedEntrySelect });
}

function entryChanged(prior: StoredEntryFields, row: BackgroundCheckListRow): boolean {
  const priorBirthDate = openEntryBirthDate(prior.sealedBirthDate);
  return (
    prior.firstName !== row.firstName
    || prior.lastName !== row.lastName
    || prior.email !== row.email
    || prior.site !== row.site
    || prior.sourceUserId !== row.sourceUserId
    || prior.complianceStatus !== row.complianceStatus
    || prior.checkedOn !== row.checkedOn
    || prior.expiresOn !== row.expiresOn
    || prior.issuesNote !== row.issuesNote
    || priorBirthDate !== row.birthDate
  );
}

/**
 * Compares by `identityKey`, so a row recognized as the same entry as before
 * (by `user_id`, email and name, birth date, or site and name) counts as
 * "changed" only when its stored fields actually differ, never "added".
 */
function countUploadChanges(existing: StoredEntryFields[], rows: BackgroundCheckListRow[]): BackgroundCheckUploadCounts {
  const existingByKey = new Map(existing.map((entry) => [entry.identityKey, entry]));
  const seenKeys = new Set<string>();
  let added = 0;
  let changed = 0;
  for (const row of rows) {
    seenKeys.add(row.identityKey);
    const prior = existingByKey.get(row.identityKey);
    if (!prior) added += 1;
    else if (entryChanged(prior, row)) changed += 1;
  }
  const dropped = existing.filter((entry) => !seenKeys.has(entry.identityKey)).length;
  return { added, changed, dropped, total: rows.length };
}

/**
 * What a preview was computed against (#527 N1): the list it compared with
 * (the latest upload's id) and the rows it read. A confirm echoes it back,
 * and is refused if either changed in between. One-way; the rows themselves
 * never leave the server this way.
 */
export function backgroundCheckUploadFingerprint(latestUploadId: string | null, rows: BackgroundCheckListRow[]) {
  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(JSON.stringify([
      row.line, row.identityKey, row.firstName, row.lastName, row.email, row.birthDate, row.site,
      row.sourceUserId, row.complianceStatus, row.checkedOn, row.expiresOn, row.issuesNote,
    ]));
    hash.update("\n");
  }
  return `${latestUploadId ?? "none"}:${hash.digest("hex")}`;
}

/** What an upload would do to the list (#527): the counts staff confirm before saving, and the preview's fingerprint. */
export async function planBackgroundCheckUpload(rows: BackgroundCheckListRow[]): Promise<BackgroundCheckUploadPreview> {
  const { rows: deduped } = dedupeListRows(rows);
  const prisma = getPrisma();
  const latest = await prisma.backgroundCheckUpload.findFirst({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, format: true } });
  const existing = await entriesOfUpload(prisma, latest?.id ?? null);
  return {
    ...countUploadChanges(existing, deduped),
    fingerprint: backgroundCheckUploadFingerprint(latest?.id ?? null, deduped),
    replacesMigratedList: latest?.format === "MIGRATION",
  };
}

// --- Matching engine: candidates, ambiguity, and the derived cache ---

type NameCandidate = { personId: string; name: string; firstName: string; lastName: string; emails: Set<string>; birthDates: Set<string>; siteNames: Set<string> };
type NameIndex = {
  byName: Map<string, NameCandidate[]>;
  /** Candidates by `matchableName(lastName)`, for first-name variant suggestions (#598). */
  byLastName: Map<string, NameCandidate[]>;
  byPerson: Map<string, NameCandidate>;
  directoryStems: Set<string>;
};

/** Registered adults are matched only for events upcoming or ended within this many months. */
const REGISTRATION_LOOKBACK_MONTHS = 12;
const BIRTH_ANSWER_KEYS = ["date_of_birth", "birth_date", "birthdate", "dob"];
const AGE_ANSWER_KEYS = ["attendee_age", "age"];

const clubSelect = { select: { name: true, parentOrganization: { select: { name: true } } } } as const;
const personEmailSelect = {
  normalizedEmail: true,
  attendeeAccountLinks: { select: { account: { select: { email: true } } } },
} as const;

function personEmails(person: { normalizedEmail?: string | null; attendeeAccountLinks?: Array<{ account: { email: string } }> | null }) {
  const emails = new Set<string>();
  if (person.normalizedEmail) emails.add(person.normalizedEmail.toLowerCase());
  for (const link of person.attendeeAccountLinks ?? []) emails.add(link.account.email.toLowerCase());
  return emails;
}

function rememberCandidate(
  byPerson: Map<string, NameCandidate>,
  personId: string,
  firstName: string,
  lastName: string,
  options: { emails?: Iterable<string>; birthDates?: Iterable<string>; sites?: Array<string | null | undefined> },
) {
  let entry = byPerson.get(personId);
  if (!entry) {
    entry = { personId, name: `${firstName} ${lastName}`.trim(), firstName, lastName, emails: new Set(), birthDates: new Set(), siteNames: new Set() };
    byPerson.set(personId, entry);
  }
  for (const email of options.emails ?? []) entry.emails.add(email);
  for (const birthDate of options.birthDates ?? []) entry.birthDates.add(birthDate);
  for (const site of options.sites ?? []) if (site) entry.siteNames.add(site);
}

function groupByName(byPerson: Map<string, NameCandidate>): Map<string, NameCandidate[]> {
  const byName = new Map<string, NameCandidate[]>();
  for (const candidate of byPerson.values()) {
    const key = matchableName(candidate.name);
    if (!key) continue;
    const list = byName.get(key) ?? [];
    list.push(candidate);
    byName.set(key, list);
  }
  return byName;
}

function groupByLastName(byPerson: Map<string, NameCandidate>): Map<string, NameCandidate[]> {
  const byLastName = new Map<string, NameCandidate[]>();
  for (const candidate of byPerson.values()) {
    const key = matchableName(candidate.lastName);
    if (!key) continue;
    const list = byLastName.get(key) ?? [];
    list.push(candidate);
    byLastName.set(key, list);
  }
  return byLastName;
}

/** A roster member is a candidate when their type is ADULT or STAFF, or their birth date makes them 18 or older today (#598). */
function rosterMemberIsAdult(attendeeType: string, birthDate: string | null, today: string) {
  if (attendeeType === "ADULT" || attendeeType === "STAFF") return true;
  const age = birthDate ? ageOn(birthDate, today) : null;
  return age !== null && age >= ADULT_AGE;
}

function attendeeAge(
  snapshot: { ageOnEventDate?: unknown },
  responses: Record<string, unknown>,
  onDate: string,
): number | null {
  if (typeof snapshot.ageOnEventDate === "number") return snapshot.ageOnEventDate;
  const ageKey = AGE_ANSWER_KEYS.find((key) => responses[key] !== undefined && responses[key] !== "");
  if (ageKey) return ageFromAnswer(responses[ageKey]);
  const birthDate = formBirthDate(responses);
  return birthDate ? ageOn(birthDate, onDate) : null;
}

/** A birth date answered on the registration form, normalized, or null. */
function formBirthDate(responses: Record<string, unknown>) {
  const birthKey = BIRTH_ANSWER_KEYS.find((key) => typeof responses[key] === "string" && responses[key]);
  return birthKey ? normalizeCheckDate(String(responses[birthKey])) : null;
}

/**
 * Every adult on a current or previous-year club roster, or registered for an event upcoming
 * or ended in the last 12 months, with their known emails, birth dates, and
 * club/church names — the candidate pool matching draws from. Built once for
 * a full pass over the whole list, or scoped to the people who share a name
 * group for a targeted refresh, so neither path scans more than it needs.
 */
export async function buildCandidateIndex(tx: PrismaLike, now: Date, scope?: { personIds: string[] }): Promise<NameIndex> {
  if (scope && scope.personIds.length === 0) return { byName: new Map(), byLastName: new Map(), byPerson: new Map(), directoryStems: new Set() };
  // The current club year and the one before it: rosters imported before the
  // September rollover (#541) still describe the same adults (#572).
  const clubYear = clubYearFor(now);
  const previousClubYear = clubYearChoices(now)[0]!;
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - REGISTRATION_LOOKBACK_MONTHS);
  const today = calendarDateInEventTimeZone(now, "America/Chicago");

  const [rosterMembers, attendees, directoryNames] = await Promise.all([
    tx.clubRosterMember.findMany({
      // Adults by type, or by age (#598): a member with a sealed birth date is
      // fetched and its age checked below, so a non-adult type on someone 18 or
      // older doesn't hide them from matching.
      where: {
        clubYear: { in: [previousClubYear, clubYear] },
        status: "ACTIVE",
        OR: [{ attendeeType: { in: ["ADULT", "STAFF"] } }, { sealedBirthDate: { not: null } }],
        personId: scope ? { in: scope.personIds } : { not: null },
      },
      select: {
        personId: true,
        attendeeType: true,
        sealedBirthDate: true,
        person: { select: { firstName: true, lastName: true, ...personEmailSelect } },
        organization: clubSelect,
      },
    }),
    tx.registrationAttendee.findMany({
      where: {
        event: { endsAt: { gte: cutoff } },
        registration: { status: { in: [...activeRegistrationStatuses] } },
        ...(scope ? { personId: { in: scope.personIds } } : {}),
      },
      select: {
        personId: true,
        attendeeType: true,
        profileSnapshot: true,
        formResponses: true,
        person: { select: { firstName: true, lastName: true, ...personEmailSelect } },
        registration: { select: { clubRegistration: { select: { organization: clubSelect } } } },
      },
    }),
    // Every club and sponsoring church, company or group name, active or not: a row that names one of them
    // exactly never falls back to its suffix-stripped key (#572).
    tx.organization.findMany({ where: { type: { in: ["CLUB", ...SPONSOR_ORGANIZATION_TYPES] } }, select: { name: true } }),
  ]);

  const byPerson = new Map<string, NameCandidate>();
  for (const member of rosterMembers) {
    if (!member.personId || !member.person) continue;
    const birthDate = openEntryBirthDate(member.sealedBirthDate);
    if (!rosterMemberIsAdult(member.attendeeType, birthDate, today)) continue;
    rememberCandidate(byPerson, member.personId, member.person.firstName, member.person.lastName, {
      emails: personEmails(member.person),
      birthDates: birthDate ? [birthDate] : [],
      sites: [member.organization.name, member.organization.parentOrganization?.name],
    });
  }
  for (const attendee of attendees) {
    if (!attendee.person) continue;
    const snapshot = (attendee.profileSnapshot ?? {}) as { ageOnEventDate?: unknown; email?: unknown };
    const responses = (attendee.formResponses ?? {}) as Record<string, unknown>;
    const age = attendeeAge(snapshot, responses, today);
    if (!attendeeIsAdult({ ageOnEventDate: age, attendeeType: attendee.attendeeType })) continue;
    const emails = personEmails(attendee.person);
    if (typeof snapshot.email === "string" && snapshot.email) emails.add(snapshot.email.trim().toLowerCase());
    const birthDate = formBirthDate(responses);
    const club = attendee.registration.clubRegistration?.organization;
    rememberCandidate(byPerson, attendee.personId, attendee.person.firstName, attendee.person.lastName, {
      emails,
      birthDates: birthDate ? [birthDate] : [],
      sites: [club?.name, club?.parentOrganization?.name],
    });
  }
  return { byName: groupByName(byPerson), byLastName: groupByLastName(byPerson), byPerson, directoryStems: directorySiteStems(directoryNames.map((organization) => organization.name)) };
}

/**
 * The coarse compacted-name expression, exactly as the #527 migration's
 * `Person_matchable_compact_idx` expression index defines it — it must stay
 * character-for-character the same, or Postgres can't use the index and
 * falls back to scanning every person.
 */
export const PERSON_COMPACT_NAME_SQL = `regexp_replace(lower(normalize("firstName" || ' ' || "lastName", NFKD)), '[^a-z0-9]+', '', 'g')`;

/**
 * The people whose `matchableName` is one of `names` (#527 N6): the same
 * grouping the full pass uses, not a case-insensitive first/last compare,
 * so "José Núñez" and "Jose Nunez" are one group. The SQL is only a coarse
 * superset filter (everything but ASCII letters and digits stripped after
 * NFKD), served by `Person_matchable_compact_idx`; the exact rule is
 * `matchableName`, applied here in TypeScript.
 */
async function peopleNamed(tx: PrismaLike, names: string[]) {
  const compacts = [...new Set(names.map((name) => name.replace(/ /g, "")).filter(Boolean))];
  if (compacts.length === 0) return [];
  const rows = await tx.$queryRaw<Array<{ id: string; firstName: string; lastName: string }>>`
    SELECT "id", "firstName", "lastName" FROM "Person"
    WHERE ${Prisma.raw(PERSON_COMPACT_NAME_SQL)} = ANY(${compacts}::text[])
  `;
  const wanted = new Set(names);
  return rows.filter((row) => wanted.has(matchableName(`${row.firstName} ${row.lastName}`)));
}

async function personIdsNamed(tx: PrismaLike, names: string[]) {
  return (await peopleNamed(tx, names)).map((row) => row.id);
}

/** How many people on file (roster or not) share each matchable name, for the name-only rule (#598). */
function namesakeCounts(people: Array<{ firstName: string; lastName: string }>) {
  const counts = new Map<string, number>();
  for (const person of people) {
    const key = matchableName(`${person.firstName} ${person.lastName}`);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

type EntryForMatch = {
  id: string;
  identityKey: string;
  firstName: string;
  lastName: string;
  normalizedName: string | null;
  email: string | null;
  sealedBirthDate: string | null;
  site: string | null;
};
type MatchedBy = "IDENTITY" | "AUTO" | "NAME_ONLY";
/**
 * `viaVariant`: a first-name variant match (#619). `viaMemory`: a name-only or
 * variant match relabelled `IDENTITY` by the remembered-match table. Neither is
 * ever written as a remembered id.
 */
type MatchResult = { entryId: string; personId: string; identityKey: string; rowName: string; matchedBy: MatchedBy; viaVariant?: boolean; viaMemory?: boolean };
type ReviewResult = { entryId: string; reason: string; candidatePersonIds: string[] };

const entryForMatchSelect = { id: true, identityKey: true, firstName: true, lastName: true, normalizedName: true, email: true, sealedBirthDate: true, site: true } as const;

/** Candidates for one entry from its name group: name plus one of email, birth date, or site. */
function candidatesForEntry(entry: Pick<EntryForMatch, "email" | "sealedBirthDate" | "site">, pool: NameCandidate[], directoryStems: ReadonlySet<string>): NameCandidate[] {
  const birthDate = openEntryBirthDate(entry.sealedBirthDate);
  const email = entry.email?.toLowerCase() ?? null;
  return pool.filter((candidate) => (
    (email && candidate.emails.has(email))
    || (birthDate && candidate.birthDates.has(birthDate))
    || (entry.site && matchesSite(entry.site, candidate.siteNames, directoryStems))
  ));
}

/**
 * Whether the row's own email or birth date rules the candidate out (#598): the
 * row has one and the candidate is known to have a different one. A candidate
 * with none on file is not contradicted; a matching one is not either.
 */
function contradictsEntry(entry: Pick<EntryForMatch, "email" | "sealedBirthDate">, candidate: NameCandidate) {
  const birthDate = openEntryBirthDate(entry.sealedBirthDate);
  const email = entry.email?.toLowerCase() ?? null;
  if (email && candidate.emails.size > 0 && !candidate.emails.has(email)) return true;
  if (birthDate && candidate.birthDates.size > 0 && !candidate.birthDates.has(birthDate)) return true;
  return false;
}

/** The most first-name variants a review lists. */
const MAX_VARIANT_CANDIDATES = 5;

/** Same last name, a first name that is a form of the row's (#598). Only ever suggested for review. */
function firstNameVariantCandidates(entry: EntryForMatch, index: NameIndex, unavailable: ReadonlySet<string>, rejected: ReadonlySet<string>) {
  const sameLast = index.byLastName.get(matchableName(entry.lastName)) ?? [];
  return sameLast
    .filter((candidate) => !unavailable.has(candidate.personId) && !rejected.has(candidate.personId) && firstNameVariant(entry.firstName, candidate.firstName) && !contradictsEntry(entry, candidate))
    .slice(0, MAX_VARIANT_CANDIDATES);
}

type MatchContext = {
  /** People on file per matchable name, roster or not. Defaults to the candidate pool alone. */
  namesakes?: ReadonlyMap<string, number>;
  /** Rows on the whole list per matchable name. Defaults to the entries passed in. */
  rowCounts?: ReadonlyMap<string, number>;
  /** People staff said a row is not, by the row's identity key (#598): never offered for that row. */
  rejected?: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Name-only and variant matches remembered by identity key (#619). Memory
   * only ever changes a label: a match the normal rules make anyway becomes
   * `IDENTITY` (so it isn't listed as new). It never makes a match itself.
   */
  remembered?: ReadonlyMap<string, { personId: string; matchedName: string }>;
  /**
   * True when the index holds every candidate on file (an upload's pass or the
   * whole-list Refresh). A first-name variant is auto-matched only then: a
   * scoped pass can't know it is the only variant.
   */
  wholeList?: boolean;
};

/** The reason text of a first-name variant review: the one review a scoped refresh can't rebuild (#598). */
const VARIANT_REVIEW_REASON = "No one has exactly this name, but a roster or registration has the same last name and a similar first name. Check whether it is the same person; it is never matched automatically.";

/** The people staff said each row (by identity key) is not (#598). */
async function rejectedPairingsFor(tx: PrismaLike, identityKeys: string[]): Promise<Map<string, Set<string>>> {
  const rejected = new Map<string, Set<string>>();
  const keys = [...new Set(identityKeys)];
  if (keys.length === 0) return rejected;
  const rows = await tx.backgroundCheckRejectedPairing.findMany({ where: { identityKey: { in: keys } }, select: { identityKey: true, personId: true } });
  for (const row of rows) {
    const set = rejected.get(row.identityKey) ?? new Set<string>();
    set.add(row.personId);
    rejected.set(row.identityKey, set);
  }
  return rejected;
}

/** The name-only and variant matches remembered for rows with no `user_id`, by identity key (#619). */
async function rememberedMatchesFor(tx: PrismaLike, identityKeys: string[]): Promise<Map<string, { personId: string; matchedName: string }>> {
  const keys = [...new Set(identityKeys)];
  if (keys.length === 0) return new Map();
  const rows = await tx.backgroundCheckRememberedMatch.findMany({ where: { identityKey: { in: keys } }, select: { identityKey: true, personId: true, matchedName: true } });
  return new Map(rows.map((row) => [row.identityKey, { personId: row.personId, matchedName: row.matchedName }]));
}

function countRowsByName(entries: Array<Pick<EntryForMatch, "normalizedName">>) {
  const counts = new Map<string, number>();
  for (const entry of entries) if (entry.normalizedName) counts.set(entry.normalizedName, (counts.get(entry.normalizedName) ?? 0) + 1);
  return counts;
}

/**
 * Matches a set of entries against people, the same rules every time (#527, #598):
 *
 * - A remembered `user_id` wins, but only when the names agree; a mismatch
 *   goes to review naming who the id actually belongs to.
 * - Otherwise, normalized name plus exactly one candidate matching on email,
 *   birth date, or site is a confident match (`AUTO`). More than one
 *   candidate is a review.
 * - When no candidate matches on those, the name alone can decide (`NAME_ONLY`,
 *   #598) but only when nothing else could be right: one candidate is the
 *   only person on file with the name, the row is the only row with it, and
 *   no email or birth date on the row contradicts them. Several same-name
 *   candidates, or several rows for one candidate, go to review; a
 *   contradiction leaves the row unmatched.
 * - With no exact-name candidate at all, a candidate with the same last name
 *   and a first name that is a form of the row's (Jon/Jonathan) is a match
 *   (`NAME_ONLY`) only when exactly one person is such a variant AND the row's
 *   email, birth date, or site agrees with them (#619); otherwise it goes to
 *   review. It is auto-matched only when the pass sees every candidate on file
 *   (`wholeList`), and is not remembered as an id (the names differ).
 * - A remembered `user_id` (an `ExternalIdentity`) is written only for `AUTO`
 *   and staff matches, never for a `NAME_ONLY` or variant one (#619): a
 *   remembered id beats the rules on every upload, so it must not outlive a
 *   guess. A rejection ("not the same person") wins over a remembered id: the
 *   row goes to review instead.
 * - Every `NAME_ONLY` match (any key kind, `user_id` keys and variants too) is
 *   written to `BackgroundCheckRememberedMatch` (#619). That memory decides
 *   nothing: the normal rules above run first, and only when they make the
 *   same `NAME_ONLY` match again is it relabelled `IDENTITY`, so staff aren't
 *   shown it as new. If the rules make a different match, or send the row to
 *   review, or the memory no longer fits, the memory is dropped (returned in
 *   `forget`) and the rules decide alone.
 * - A person matched by more than one entry is also a review, for every
 *   entry that matched them — never guessed which one is right.
 * - `unavailable` people already hold a match that isn't being recomputed
 *   (a staff decision, a migrated check, or an entry outside this pass): they
 *   aren't candidates, and a remembered id pointing at one goes to review.
 */
function matchEntries(
  entries: EntryForMatch[],
  index: NameIndex,
  identityByKey: Map<string, { personId: string; name: string }>,
  unavailable: Set<string> = new Set(),
  context: MatchContext = {},
): { matches: MatchResult[]; reviews: ReviewResult[]; forget: string[]; rememberedMatched: number } {
  const reviews: ReviewResult[] = [];
  const viaIdentityBranch = new Set<string>();
  const rowCounts = context.rowCounts ?? countRowsByName(entries);
  const tentativeByPerson = new Map<string, Array<{ entryId: string; identityKey: string; rowName: string; matchedBy: MatchedBy; viaVariant?: boolean }>>();
  const pushTentative = (entry: EntryForMatch, personId: string, matchedBy: MatchedBy, viaVariant = false) => {
    const list = tentativeByPerson.get(personId) ?? [];
    list.push({ entryId: entry.id, identityKey: entry.identityKey, rowName: entry.normalizedName ?? "", matchedBy, viaVariant });
    tentativeByPerson.set(personId, list);
  };

  for (const entry of entries) {
    if (!entry.normalizedName) continue; // Not normalized yet; the next refresh fills it in first.
    const identity = identityByKey.get(entry.identityKey);
    if (identity) {
      viaIdentityBranch.add(entry.id);
      if (matchableName(identity.name) === entry.normalizedName && context.rejected?.get(entry.identityKey)?.has(identity.personId)) {
        // Staff said this row is not this person: a remembered id doesn't override that (#598).
        reviews.push({
          entryId: entry.id,
          reason: "The remembered match for this row is a person staff said it is not. Nothing was guessed; match it by hand if that is wrong.",
          candidatePersonIds: [identity.personId],
        });
      } else if (matchableName(identity.name) !== entry.normalizedName) {
        reviews.push({
          entryId: entry.id,
          reason: `The remembered match for this row belongs to ${identity.name}, but this row's name is different. Check it and match by hand.`,
          candidatePersonIds: [identity.personId],
        });
      } else if (unavailable.has(identity.personId)) {
        reviews.push({
          entryId: entry.id,
          reason: "The remembered match for this row is already matched to another row. Nothing was guessed; match it by hand.",
          candidatePersonIds: [identity.personId],
        });
      } else {
        pushTentative(entry, identity.personId, "IDENTITY");
      }
      continue;
    }
    const sameName = index.byName.get(entry.normalizedName) ?? [];
    const rejectedHere = context.rejected?.get(entry.identityKey) ?? new Set<string>();
    const pool = sameName.filter((candidate) => !unavailable.has(candidate.personId) && !rejectedHere.has(candidate.personId));
    const candidates = candidatesForEntry(entry, pool, index.directoryStems);
    if (candidates.length > 1) {
      reviews.push({
        entryId: entry.id,
        reason: "More than one person matches this row's name and identifying details. Nothing was guessed; match it by hand.",
        candidatePersonIds: candidates.map((candidate) => candidate.personId),
      });
      continue;
    }
    if (candidates.length === 1) {
      pushTentative(entry, candidates[0]!.personId, "AUTO");
      continue;
    }
    if (pool.length > 0) {
      // The name is right but nothing else agrees (usually the site): the name alone may decide.
      const possible = pool.filter((candidate) => !contradictsEntry(entry, candidate));
      if (possible.length === 0) continue; // Their email or birth date disagrees: not this person.
      const namesakes = context.namesakes?.get(entry.normalizedName) ?? possible.length;
      if (possible.length === 1 && namesakes <= 1 && (rowCounts.get(entry.normalizedName) ?? 1) <= 1) {
        pushTentative(entry, possible[0]!.personId, "NAME_ONLY");
        continue;
      }
      reviews.push({
        entryId: entry.id,
        reason: possible.length > 1
          ? "More than one person has this row's name, and nothing on the row tells them apart. Nothing was guessed; match it by hand."
          : (rowCounts.get(entry.normalizedName) ?? 1) > 1
            ? "More than one row on this list has this name, and the site doesn't match. Nothing was guessed; match it by hand."
            : "This row's name matches someone, but the site doesn't and another person on file has the same name. Nothing was guessed; match it by hand.",
        candidatePersonIds: possible.map((candidate) => candidate.personId),
      });
      continue;
    }
    if (sameName.length > 0) continue; // Only someone already matched to another row, or one staff rejected: nothing left to suggest.
    const variants = firstNameVariantCandidates(entry, index, unavailable, rejectedHere);
    if (context.wholeList && variants.length === 1 && candidatesForEntry(entry, variants, index.directoryStems).length === 1) {
      // Exactly one person has this surname with a variant first name, and the
      // row's email, birth date, or site agrees with them (#619).
      pushTentative(entry, variants[0]!.personId, "NAME_ONLY", true);
      continue;
    }
    if (variants.length > 0) {
      reviews.push({
        entryId: entry.id,
        reason: VARIANT_REVIEW_REASON,
        candidatePersonIds: variants.map((candidate) => candidate.personId),
      });
    }
    // Otherwise it stays on the list, unmatched: not a review, it just isn't anyone yet.
  }

  const matches: MatchResult[] = [];
  for (const [personId, list] of tentativeByPerson) {
    if (list.length === 1) {
      matches.push({ entryId: list[0]!.entryId, identityKey: list[0]!.identityKey, rowName: list[0]!.rowName, personId, matchedBy: list[0]!.matchedBy, ...(list[0]!.viaVariant ? { viaVariant: true } : {}) });
      continue;
    }
    for (const item of list) {
      reviews.push({
        entryId: item.entryId,
        reason: "More than one row on this list matches this person. Nothing was guessed; match it by hand.",
        candidatePersonIds: [personId],
      });
    }
  }
  // Memory changes labels and is dropped when stale (#619). It never decides.
  const forget: string[] = [];
  let rememberedMatched = 0;
  if (context.remembered && context.remembered.size > 0) {
    const finalByEntry = new Map(matches.map((match) => [match.entryId, match]));
    for (const entry of entries) {
      const memory = context.remembered.get(entry.identityKey);
      if (!memory || viaIdentityBranch.has(entry.id) || !entry.normalizedName) continue;
      const match = finalByEntry.get(entry.id);
      const person = index.byPerson.get(memory.personId);
      const fits = Boolean(person)
        && memory.matchedName === entry.normalizedName
        && !context.rejected?.get(entry.identityKey)?.has(memory.personId)
        && !contradictsEntry(entry, person!)
        && (matchableName(`${person!.firstName} ${person!.lastName}`) === entry.normalizedName
          || (matchableName(person!.lastName) === matchableName(entry.lastName) && firstNameVariant(entry.firstName, person!.firstName)));
      if (match && match.personId === memory.personId) {
        if (match.matchedBy === "NAME_ONLY" && fits) {
          match.matchedBy = "IDENTITY";
          match.viaMemory = true;
          rememberedMatched += 1;
        } else if (!fits) {
          forget.push(entry.identityKey);
        }
        continue;
      }
      // A different person, a review, or nothing. A scoped pass can't tell
      // "nothing" from "not in this index", so it drops only what it can see is wrong.
      if (match || (person && !fits) || context.wholeList) forget.push(entry.identityKey);
    }
  }
  return { matches, reviews, forget, rememberedMatched };
}

async function identitiesByKeys(tx: PrismaLike, identityKeys: string[]) {
  const keys = identityKeys.filter(isRememberedIdentityKey);
  if (keys.length === 0) return new Map<string, { personId: string; name: string }>();
  const identities = await tx.externalIdentity.findMany({
    where: { provider: ROSTER_IMPORT_PROVIDER, providerScope: "", externalId: { in: keys } },
    select: { externalId: true, personId: true, person: { select: { firstName: true, lastName: true } } },
  });
  return new Map(
    identities
      .filter((identity): identity is typeof identity & { personId: string; person: NonNullable<typeof identity.person> } => Boolean(identity.personId && identity.person))
      .map((identity) => [identity.externalId, { personId: identity.personId, name: `${identity.person.firstName} ${identity.person.lastName}`.trim() }]),
  );
}

/**
 * Records or refreshes the remembered `user_id` for every confident match
 * of a `user_id` entry (#527 B2), as the roster import did before: a
 * matching identity is re-verified, a new one is created, and one that
 * already belongs to someone else — or a person already remembered under a
 * different id — is never overwritten. Never for a key that isn't a
 * provider `user_id` (N3).
 */
async function rememberUserIdIdentities(tx: PrismaLike, matches: Array<{ personId: string; identityKey: string }>, now: Date) {
  const toRemember = matches.filter((match) => isRememberedIdentityKey(match.identityKey));
  if (toRemember.length === 0) return;
  const keys = [...new Set(toRemember.map((match) => match.identityKey))];
  const personIds = [...new Set(toRemember.map((match) => match.personId))];
  const [byKey, byPerson] = await Promise.all([
    tx.externalIdentity.findMany({
      where: { provider: ROSTER_IMPORT_PROVIDER, providerScope: "", externalId: { in: keys } },
      select: { id: true, externalId: true, personId: true },
    }),
    tx.externalIdentity.findMany({
      where: { provider: ROSTER_IMPORT_PROVIDER, providerScope: "", personId: { in: personIds } },
      select: { id: true, externalId: true, personId: true },
    }),
  ]);
  const identityByKey = new Map(byKey.map((identity) => [identity.externalId, identity]));
  const keyByPerson = new Map(byPerson.map((identity) => [identity.personId as string, identity.externalId]));
  const toVerify: string[] = [];
  const toCreate: Array<{ personId: string; provider: typeof ROSTER_IMPORT_PROVIDER; providerScope: string; externalId: string; lastVerifiedAt: Date }> = [];
  for (const match of toRemember) {
    const known = identityByKey.get(match.identityKey);
    const personHas = keyByPerson.get(match.personId);
    if (known?.personId === match.personId) {
      toVerify.push(known.id);
    } else if (known?.personId || (personHas !== undefined && personHas !== match.identityKey)) {
      continue; // Belongs to someone else, or this person already has another id: never overwritten.
    } else if (known) {
      const attached = await tx.externalIdentity.updateMany({ where: { id: known.id, personId: null }, data: { personId: match.personId, lastVerifiedAt: now } });
      if (attached.count > 0) keyByPerson.set(match.personId, match.identityKey);
    } else {
      toCreate.push({ personId: match.personId, provider: ROSTER_IMPORT_PROVIDER, providerScope: "", externalId: match.identityKey, lastVerifiedAt: now });
      keyByPerson.set(match.personId, match.identityKey);
      identityByKey.set(match.identityKey, { id: "", externalId: match.identityKey, personId: match.personId });
    }
  }
  if (toVerify.length > 0) await tx.externalIdentity.updateMany({ where: { id: { in: toVerify } }, data: { lastVerifiedAt: now } });
  if (toCreate.length > 0) await tx.externalIdentity.createMany({ data: toCreate, skipDuplicates: true });
}

type MemoryCounts = { rememberedMatched: number; rememberedWritten: number; forgotRemembered: number };
const NO_MEMORY_COUNTS: MemoryCounts = { rememberedMatched: 0, rememberedWritten: 0, forgotRemembered: 0 };
async function saveMatchResults(tx: PrismaLike, matches: MatchResult[], reviews: ReviewResult[], now: Date, memory: { forget: string[]; rememberedMatched: number } = { forget: [], rememberedMatched: 0 }): Promise<MemoryCounts> {
  if (matches.length > 0) {
    await tx.backgroundCheckMatch.createMany({
      data: matches.map((match) => ({ personId: match.personId, entryId: match.entryId, matchedBy: match.matchedBy })),
      // A concurrent refresh may have just written the same pair: never a duplicate, never an error.
      skipDuplicates: true,
    });
  }
  if (reviews.length > 0) {
    await tx.backgroundCheckReview.createMany({
      data: reviews.map((review) => ({ entryId: review.entryId, reason: review.reason, candidatePersonIds: review.candidatePersonIds })),
      // One review per entry (#527 N2): a concurrent refresh's review wins, never a second row.
      skipDuplicates: true,
    });
  }
  // A remembered id beats the rules on every later upload, so only a match the
  // rules stand behind may write one: `AUTO`, an `IDENTITY` that already had
  // one, and (elsewhere) a staff hand match. Never a name-only or variant match
  // (#619): those live only in `BackgroundCheckRememberedMatch`, which decides
  // nothing and only relabels a match the rules make again.
  await rememberUserIdIdentities(tx, matches.filter((match) => match.matchedBy !== "NAME_ONLY" && !match.viaVariant && !match.viaMemory), now);
  // Every name-only match, whatever its key, and every variant match is also
  // written to `BackgroundCheckRememberedMatch` (#619): the origin marker that
  // lets staff reject a later `IDENTITY` match, and the memory that keeps a
  // no-`user_id` or variant match off the spot-check list. A stale memory
  // (the rules made another match, or none) is dropped first.
  let forgotRemembered = 0;
  if (memory.forget.length > 0) {
    forgotRemembered = (await tx.backgroundCheckRememberedMatch.deleteMany({ where: { identityKey: { in: [...new Set(memory.forget)] } } })).count;
  }
  const nameOnly = matches.filter((match) => match.matchedBy === "NAME_ONLY");
  let rememberedWritten = 0;
  if (nameOnly.length > 0) {
    const existing = await rememberedMatchesFor(tx, nameOnly.map((match) => match.identityKey));
    const toWrite = nameOnly.filter((match) => {
      const known = existing.get(match.identityKey);
      return !(known && known.personId === match.personId && known.matchedName === match.rowName);
    });
    if (toWrite.length > 0) {
      await tx.backgroundCheckRememberedMatch.deleteMany({ where: { identityKey: { in: toWrite.map((match) => match.identityKey) } } });
      await tx.backgroundCheckRememberedMatch.createMany({
        data: toWrite.map((match) => ({ identityKey: match.identityKey, personId: match.personId, matchedName: match.rowName, matchedBy: match.viaVariant ? "VARIANT" : "NAME_ONLY" })),
        skipDuplicates: true,
      });
      rememberedWritten = toWrite.length;
    }
  }
  return { rememberedMatched: memory.rememberedMatched, rememberedWritten, forgotRemembered };
}

/** Every entry in a fresh upload, matched once, in one bounded pass (#527). */
async function runFullMatchPass(
  tx: PrismaLike,
  uploadId: string,
  now: Date,
  kept: { entryIds: Set<string>; personIds: Set<string> },
): Promise<MemoryCounts> {
  const everyEntry = await tx.backgroundCheckEntry.findMany({ where: { uploadId }, select: entryForMatchSelect });
  const entries = everyEntry.filter((entry) => !kept.entryIds.has(entry.id));
  if (entries.length === 0) return NO_MEMORY_COUNTS;
  const [index, identityByKey, rejected, remembered, named] = await Promise.all([
    buildCandidateIndex(tx, now),
    identitiesByKeys(tx, [...new Set(entries.map((entry) => entry.identityKey))]),
    rejectedPairingsFor(tx, entries.map((entry) => entry.identityKey)),
    rememberedMatchesFor(tx, entries.map((entry) => entry.identityKey)),
    peopleNamed(tx, [...new Set(entries.map((entry) => entry.normalizedName).filter((name): name is string => Boolean(name)))]),
  ]);
  const { matches, reviews, forget, rememberedMatched } = matchEntries(entries, index, identityByKey, kept.personIds, {
    namesakes: namesakeCounts(named),
    rowCounts: countRowsByName(everyEntry),
    rejected,
    remembered,
    wholeList: true,
  });
  return saveMatchResults(tx, matches, reviews, now, { forget, rememberedMatched });
}

/**
 * Recomputes every derived match for the entries and people in the given
 * name groups (#527), or for the whole list when `names` is null (the staff
 * Refresh, #598: the only path that also looks for first-name variants,
 * because it sees every roster and registration adult, not just one name
 * group). Only `AUTO`/`IDENTITY`/`NAME_ONLY` matches are cleared and
 * recomputed (B1): a `MANUAL` or `MIGRATED` match stays exactly as it is,
 * and its entry and person sit this pass out.
 */
async function recomputeNameGroups(tx: PrismaLike, uploadId: string, names: string[] | null, now: Date): Promise<MemoryCounts> {
  const whole = names === null;
  const groupNames = [...new Set((names ?? []).filter(Boolean))];
  if (!whole && groupNames.length === 0) return NO_MEMORY_COUNTS;
  // A scoped refresh locks its entry rows first, so a staff "not the same
  // person" on one of them (which locks the row too) either lands before this
  // reads or waits for it: the refresh never re-inserts over a rejection
  // (#598). The whole-list Refresh holds the list lock exclusively instead.
  if (!whole) await lockEntriesNamed(tx, uploadId, groupNames);
  const entries = await tx.backgroundCheckEntry.findMany({
    where: whole ? { uploadId } : { uploadId, normalizedName: { in: groupNames } },
    select: {
      ...entryForMatchSelect,
      match: { select: { personId: true, matchedBy: true } },
      review: { select: { dismissedAt: true, candidatePersonIds: true, reason: true } },
    },
  });
  const named = await peopleNamed(tx, whole ? [...new Set(entries.map((entry) => entry.normalizedName).filter((name): name is string => Boolean(name)))] : groupNames);
  const personIds = named.map((row) => row.id);
  // Staff said none of the candidates is right: that entry matches no one until the next upload.
  const dismissed = (entry: (typeof entries)[number]) => Boolean(entry.review?.dismissedAt);
  const reviewCandidates = (entry: (typeof entries)[number]) => (
    Array.isArray(entry.review?.candidatePersonIds) ? entry.review.candidatePersonIds as string[] : []
  );
  // People a dismissed review named are held until staff decide the rest:
  // dismissing one of two "rows match this person" reviews says nothing about
  // the other row, so that row's review stays open and the person isn't
  // auto-matched to it (#527) — until staff resolve it, or the next upload.
  const held = new Set(entries.filter(dismissed).flatMap(reviewCandidates));
  const heldOpenReview = (entry: (typeof entries)[number]) => (
    Boolean(entry.review) && !dismissed(entry) && reviewCandidates(entry).some((personId) => held.has(personId))
  );
  // A scoped pass can't rebuild a first-name variant match (its index holds
  // one name group, not everyone with that last name), so it leaves a match
  // alone only when all of these hold (#619): the person's name differs from
  // the row's but is still a first-name variant with the same last name,
  // nothing on the row contradicts them, no one with the row's exact name is
  // now in the group, and it is not a remembered `user_id` (a renamed person
  // there goes to review, as a mismatched id always does). Otherwise it is
  // recomputed like any other match.
  const variantMatchedIds = new Set<string>();
  if (!whole) {
    const heldMatches = entries.filter((entry) => entry.match?.matchedBy === "NAME_ONLY" || entry.match?.matchedBy === "IDENTITY");
    if (heldMatches.length > 0) {
      const matchedIndex = await buildCandidateIndex(tx, now, { personIds: heldMatches.map((entry) => entry.match!.personId) });
      const realIds = await identitiesByKeys(tx, heldMatches.map((entry) => entry.identityKey));
      const exactNames = new Set(named.map((row) => matchableName(`${row.firstName} ${row.lastName}`)));
      for (const entry of heldMatches) {
        const person = matchedIndex.byPerson.get(entry.match!.personId);
        if (!person || !entry.normalizedName) continue;
        if (matchableName(`${person.firstName} ${person.lastName}`) === entry.normalizedName) continue;
        if (exactNames.has(entry.normalizedName)) continue;
        // A real remembered id (not a name-only memory) means a rename is a mismatch: recompute.
        if (entry.match!.matchedBy === "IDENTITY" && realIds.get(entry.identityKey)?.personId === entry.match!.personId) continue;
        if (matchableName(person.lastName) !== matchableName(entry.lastName) || !firstNameVariant(entry.firstName, person.firstName)) continue;
        if (contradictsEntry(entry, person)) continue;
        variantMatchedIds.add(entry.id);
      }
    }
  }
  // A `NAME_ONLY` match stays labelled so for the life of this upload even
  // once it is remembered (a Refresh finds it as `IDENTITY`): the spot-check
  // list is what is new since the last upload (#619).
  const nameOnlyBefore = new Map(entries.filter((entry) => entry.match?.matchedBy === "NAME_ONLY").map((entry) => [entry.id, entry.match!.personId]));
  const derivedEntryIds = entries.filter((entry) => entry.match && !LOCKED_SOURCES.has(entry.match.matchedBy) && !variantMatchedIds.has(entry.id)).map((entry) => entry.id);
  if (derivedEntryIds.length > 0) {
    await tx.backgroundCheckMatch.deleteMany({ where: { entryId: { in: derivedEntryIds }, matchedBy: { in: [...DERIVED_SOURCES] } } });
  }
  const reopened = entries.filter((entry) => !heldOpenReview(entry));
  // Open reviews are cleared and rebuilt, except (scoped passes only) a
  // first-name variant review this pass can't rebuild, because its candidate
  // index holds one name group, not everyone with that last name (#598). It
  // stays unless the entry now has a match or a new review of its own.
  const clearOpenReviews = async (rebuiltEntryIds: Set<string>) => {
    const ids = reopened
      .filter((entry) => whole || entry.review?.reason !== VARIANT_REVIEW_REASON || rebuiltEntryIds.has(entry.id))
      .map((entry) => entry.id);
    if (ids.length > 0) await tx.backgroundCheckReview.deleteMany({ where: { entryId: { in: ids }, dismissedAt: null } });
  };

  const toMatch = entries.filter((entry) => (
    !(entry.match && LOCKED_SOURCES.has(entry.match.matchedBy)) && !variantMatchedIds.has(entry.id) && !dismissed(entry) && !heldOpenReview(entry)
  ));
  if (toMatch.length === 0) {
    await clearOpenReviews(new Set());
    return NO_MEMORY_COUNTS;
  }
  const [index, identityByKey, rejected, remembered, stillMatched] = await Promise.all([
    buildCandidateIndex(tx, now, whole ? undefined : { personIds }),
    identitiesByKeys(tx, [...new Set(toMatch.map((entry) => entry.identityKey))]),
    rejectedPairingsFor(tx, toMatch.map((entry) => entry.identityKey)),
    rememberedMatchesFor(tx, toMatch.map((entry) => entry.identityKey)),
    whole
      ? tx.backgroundCheckMatch.findMany({ select: { personId: true } })
      : personIds.length > 0
        ? tx.backgroundCheckMatch.findMany({ where: { personId: { in: personIds } }, select: { personId: true } })
        : Promise.resolve([] as Array<{ personId: string }>),
  ]);
  const unavailable = new Set(stillMatched.map((match) => match.personId));
  // A remembered id can point at someone outside the name group only when
  // the names disagree (a review, never a match), so this covers everyone.
  const result = matchEntries(toMatch, index, identityByKey, unavailable, {
    namesakes: namesakeCounts(named),
    rowCounts: countRowsByName(entries),
    rejected,
    remembered,
    wholeList: whole,
  });
  const matches = result.matches
    .filter((match) => !held.has(match.personId))
    .map((match) => (match.matchedBy === "IDENTITY" && nameOnlyBefore.get(match.entryId) === match.personId ? { ...match, matchedBy: "NAME_ONLY" as const } : match));
  const reviews = [
    ...result.reviews,
    ...result.matches.filter((match) => held.has(match.personId)).map((match) => ({
      entryId: match.entryId,
      reason: "Staff dismissed another row that matched this person. Nothing was guessed; match this one by hand, or dismiss it too.",
      candidatePersonIds: [match.personId],
    })),
  ];
  await clearOpenReviews(new Set([...matches.map((match) => match.entryId), ...reviews.map((review) => review.entryId)]));
  return saveMatchResults(tx, matches, reviews, now, { forget: result.forget, rememberedMatched: result.rememberedMatched });
}

/**
 * Row-locks the entries in the given name groups until the transaction ends
 * (#598). `FOR NO KEY UPDATE`, not `FOR UPDATE`: inserting a match or review
 * takes `FOR KEY SHARE` on its entry, which `FOR UPDATE` would conflict with
 * (a staff hand match could then deadlock with a scoped refresh); this
 * still excludes other writers of the same entry.
 */
async function lockEntriesNamed(tx: PrismaLike, uploadId: string, names: string[]) {
  await tx.$queryRaw`
    SELECT "id" FROM "BackgroundCheckEntry"
    WHERE "uploadId" = ${uploadId} AND "normalizedName" = ANY(${names}::text[])
    ORDER BY "id" FOR NO KEY UPDATE
  `;
}

const REFRESH_CHUNK = 100;

/**
 * Re-matches the name groups the given people belong to — now, and before
 * any rename (their old derived match's entry) — so someone already on the
 * list is matched without a re-upload (#527), without rescanning the whole
 * list or the whole roster. Called after every write that adds or edits a
 * person; see `refresh-after-write.ts` for the best-effort wrapper those
 * writes use.
 */
export async function refreshBackgroundCheckMatches(personIds: Iterable<string>, now = new Date()) {
  const ids = [...new Set([...personIds].filter(Boolean))];
  if (ids.length === 0) return;
  const prisma = getPrisma();
  if (!(await latestUpload(prisma))) return;
  for (let start = 0; start < ids.length; start += REFRESH_CHUNK) {
    const chunk = ids.slice(start, start + REFRESH_CHUNK);
    const refreshed = await prisma.$transaction(async (tx) => {
      // Never waits on an upload (#527): skipped instead, and covered by the
      // read path and the upload's own full pass.
      if (!(await tryListLock(tx))) return false;
      const current = await latestUpload(tx);
      if (!current) return true;
      await backfillNormalizedNames(tx);
      const people = await tx.person.findMany({
        where: { id: { in: chunk } },
        select: { id: true, firstName: true, lastName: true, backgroundCheckMatch: { select: { matchedBy: true, entry: { select: { normalizedName: true } } } } },
      });
      const names = new Set<string>();
      for (const person of people) {
        names.add(matchableName(`${person.firstName} ${person.lastName}`));
        const priorName = person.backgroundCheckMatch?.entry.normalizedName;
        if (priorName && !LOCKED_SOURCES.has(person.backgroundCheckMatch!.matchedBy)) names.add(priorName);
      }
      await recomputeNameGroups(tx, current.id, [...names], now);
      return true;
    }, { timeout: 30_000, maxWait: 10_000 });
    if (!refreshed) {
      logInfo("Sterling Volunteers match refresh skipped while a list upload is in progress", { people: ids.length });
      return;
    }
  }
}

/**
 * The list lock, shared, without waiting (#527): false while an upload holds
 * it. Writers that aren't the upload use this, so a user's save is never held
 * up behind a long upload.
 */
async function tryListLock(tx: PrismaLike) {
  const [row] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock_shared(${BACKGROUND_CHECK_LOCK_KEY}::bigint) AS locked`;
  return Boolean(row?.locked);
}

/**
 * The list lock, exclusive, without waiting (#598): false while an upload, a
 * per-person refresh, a staff decision, or another Refresh holds it. Holding it
 * keeps every shared-lock writer (per-person refresh, review and reject
 * decisions) out for the length of a whole-list Refresh, and stops two Refreshes
 * from running at once.
 */
async function tryExclusiveListLock(tx: PrismaLike) {
  const [row] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(${BACKGROUND_CHECK_LOCK_KEY}::bigint) AS locked`;
  return Boolean(row?.locked);
}

async function requireListLock(tx: PrismaLike) {
  if (!(await tryListLock(tx))) {
    throw new BackgroundCheckOperationError("UPLOAD_IN_PROGRESS", "A Sterling Volunteers list upload is in progress. Try again in a moment.");
  }
}

/** One person's refresh: see `refreshBackgroundCheckMatches`. */
export async function refreshBackgroundCheckMatchForPerson(personId: string, now = new Date()) {
  await refreshBackgroundCheckMatches([personId], now);
}

/**
 * Records the upload: replaces the list wholesale and re-matches it (#527).
 * Under an exclusive advisory lock (N1), so two confirms never interleave:
 * the counts are computed inside the transaction against the list as it is
 * then, and a confirm whose preview was computed against a different list
 * or different rows is refused (`PREVIEW_CHANGED`). A staff match (N2) is
 * carried to the new entry with the same identity key, whatever its name.
 * Audits only counts — never names or dates.
 */
export async function applyBackgroundCheckUpload(
  rows: BackgroundCheckListRow[],
  format: "ROSTER" | "STERLING",
  actorUserId: string,
  now = new Date(),
  options: { expectedFingerprint?: string } = {},
): Promise<BackgroundCheckUploadCounts> {
  const { rows: deduped } = dedupeListRows(rows);
  return getPrisma().$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BACKGROUND_CHECK_LOCK_KEY}::bigint)`;
    const previousLatest = await latestUpload(tx);
    if (
      options.expectedFingerprint !== undefined
      && options.expectedFingerprint !== backgroundCheckUploadFingerprint(previousLatest?.id ?? null, deduped)
    ) {
      throw new BackgroundCheckOperationError("PREVIEW_CHANGED", "The list or the file changed since this preview. Upload the file again to see the current counts.");
    }
    const counts = countUploadChanges(await entriesOfUpload(tx, previousLatest?.id ?? null), deduped);
    const manualMatches = await tx.backgroundCheckMatch.findMany({
      where: { matchedBy: "MANUAL" },
      select: { personId: true, entry: { select: { identityKey: true } } },
    });

    const upload = await tx.backgroundCheckUpload.create({
      data: { format, rowCount: deduped.length, added: counts.added, changed: counts.changed, dropped: counts.dropped, uploadedByUserId: actorUserId },
    });
    if (deduped.length > 0) {
      await tx.backgroundCheckEntry.createMany({
        data: deduped.map((row) => ({
          uploadId: upload.id,
          line: row.line,
          firstName: row.firstName,
          lastName: row.lastName,
          normalizedName: row.normalizedName,
          email: row.email,
          sealedBirthDate: row.birthDate ? sealBirthDate(row.birthDate) : null,
          site: row.site,
          sourceUserId: row.sourceUserId,
          identityKey: row.identityKey,
          complianceStatus: row.complianceStatus,
          checkedOn: row.checkedOn,
          expiresOn: row.expiresOn,
          issuesNote: row.issuesNote,
        })),
      });
    }
    // Everything that isn't this upload goes: the list is exactly this file.
    await tx.backgroundCheckEntry.deleteMany({ where: { uploadId: { not: upload.id } } });

    const kept = { entryIds: new Set<string>(), personIds: new Set<string>() };
    if (manualMatches.length > 0) {
      const newEntries = await tx.backgroundCheckEntry.findMany({ where: { uploadId: upload.id }, select: { id: true, identityKey: true } });
      const entryIdByKey = new Map(newEntries.map((entry) => [entry.identityKey, entry.id]));
      const carried: Array<{ personId: string; entryId: string; matchedBy: "MANUAL" }> = [];
      for (const match of manualMatches) {
        const entryId = entryIdByKey.get(match.entry.identityKey);
        if (!entryId || kept.entryIds.has(entryId) || kept.personIds.has(match.personId)) continue;
        carried.push({ personId: match.personId, entryId, matchedBy: "MANUAL" });
        kept.entryIds.add(entryId);
        kept.personIds.add(match.personId);
      }
      if (carried.length > 0) await tx.backgroundCheckMatch.createMany({ data: carried });
    }
    const memoryCounts = await runFullMatchPass(tx, upload.id, now, kept);
    await writeAuditLog({
      actorUserId,
      action: "BACKGROUND_CHECK_LIST_UPLOADED",
      entityType: "BackgroundCheckUpload",
      entityId: upload.id,
      summary: `Uploaded a Sterling Volunteers list of ${deduped.length} row${deduped.length === 1 ? "" : "s"} (${format === "ROSTER" ? "roster" : "Sterling"} format): ${counts.added} added, ${counts.changed} changed, ${counts.dropped} dropped.`,
      metadata: { format, rowCount: deduped.length, added: counts.added, changed: counts.changed, dropped: counts.dropped, manualMatchesKept: kept.entryIds.size, ...memoryCounts },
    }, tx);
    return counts;
  }, { timeout: 120_000, maxWait: 15_000 });
}

// --- Staff review: ambiguous matches, resolved by hand and remembered ---

export type BackgroundCheckReviewCandidate = { personId: string; name: string; sites: string[] };
export type BackgroundCheckReviewItem = {
  id: string;
  entryId: string;
  name: string;
  site: string | null;
  reason: string;
  candidates: BackgroundCheckReviewCandidate[];
};

/** Every entry, or person, still waiting on a staff decision (#527). Staff-only. */
export async function listBackgroundCheckReviews(): Promise<BackgroundCheckReviewItem[]> {
  const prisma = getPrisma();
  const reviews = await prisma.backgroundCheckReview.findMany({
    where: { dismissedAt: null },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      reason: true,
      candidatePersonIds: true,
      entry: { select: { id: true, firstName: true, lastName: true, site: true } },
    },
  });
  const personIds = [...new Set(reviews.flatMap((review) => (Array.isArray(review.candidatePersonIds) ? review.candidatePersonIds as string[] : [])))];
  const people = personIds.length > 0
    ? await prisma.person.findMany({
      where: { id: { in: personIds } },
      select: { id: true, firstName: true, lastName: true, clubRosterMemberships: { where: { status: "ACTIVE" }, select: { organization: { select: { name: true } } } } },
    })
    : [];
  const peopleById = new Map(people.map((person) => [person.id, person]));
  return reviews.map((review) => ({
    id: review.id,
    entryId: review.entry.id,
    name: `${review.entry.firstName} ${review.entry.lastName}`.trim(),
    site: review.entry.site,
    reason: review.reason,
    candidates: (review.candidatePersonIds as string[]).map((personId) => {
      const person = peopleById.get(personId);
      return person
        ? { personId, name: `${person.firstName} ${person.lastName}`.trim(), sites: person.clubRosterMemberships.map((membership) => membership.organization.name) }
        : { personId, name: "(person no longer on file)", sites: [] };
    }),
  }));
}

/**
 * A staff match: a remembered `user_id` for the row, the `MANUAL` match itself
 * (replacing whatever either side held), and the end of any earlier "not the
 * same person" for this pair (#598). The caller holds the list lock.
 */
async function applyManualMatch(tx: PrismaLike, entry: { id: string; identityKey: string }, personId: string) {
  if (!(await tx.person.findUnique({ where: { id: personId }, select: { id: true } }))) {
    throw new BackgroundCheckOperationError("NOT_A_CANDIDATE", "That person is no longer on file.");
  }
  if (isRememberedIdentityKey(entry.identityKey)) {
    const now = new Date();
    await tx.externalIdentity.deleteMany({
      where: { provider: ROSTER_IMPORT_PROVIDER, providerScope: "", personId, NOT: { externalId: entry.identityKey } },
    });
    await tx.externalIdentity.upsert({
      where: { provider_providerScope_externalId: { provider: ROSTER_IMPORT_PROVIDER, providerScope: "", externalId: entry.identityKey } },
      create: { provider: ROSTER_IMPORT_PROVIDER, providerScope: "", externalId: entry.identityKey, personId, lastVerifiedAt: now },
      update: { personId, lastVerifiedAt: now },
    });
  }
  await tx.backgroundCheckMatch.deleteMany({ where: { OR: [{ personId }, { entryId: entry.id }] } });
  await tx.backgroundCheckMatch.create({ data: { personId, entryId: entry.id, matchedBy: "MANUAL" } });
  await tx.backgroundCheckRejectedPairing.deleteMany({ where: { identityKey: entry.identityKey, personId } });
  // Superseded by the staff match (#619).
  await tx.backgroundCheckRememberedMatch.deleteMany({ where: { identityKey: entry.identityKey } });
  await tx.backgroundCheckReview.deleteMany({ where: { entryId: entry.id } });
}

/**
 * Staff pick a person by hand, or say none of the candidates is right
 * (#527). A pick is a `MANUAL` match: a staff decision that holds across
 * refreshes and uploads, even if the names differ, until staff undo it (N2).
 * A `user_id` entry's pick is also remembered as that id's identity. A
 * dismissal is kept (`dismissedAt`): that entry is matched to no one — by a
 * refresh or at read time — until the next upload replaces the list. Takes
 * the list lock shared, without waiting: during an upload it is refused
 * (`UPLOAD_IN_PROGRESS`, 409) rather than held up.
 */
export async function resolveBackgroundCheckReview(
  reviewId: string,
  decision: { type: "match"; personId: string } | { type: "dismiss" },
  actorUserId: string,
) {
  const prisma = getPrisma();
  const notFound = () => new BackgroundCheckOperationError("REVIEW_NOT_FOUND", "That review was already resolved or no longer exists. Refresh the list.");
  await prisma.$transaction(async (tx) => {
    await requireListLock(tx);
    const review = await tx.backgroundCheckReview.findUnique({
      where: { id: reviewId },
      select: { id: true, entryId: true, candidatePersonIds: true, dismissedAt: true, entry: { select: { identityKey: true } } },
    });
    if (!review || review.dismissedAt || !review.entry) throw notFound();
    if (decision.type === "match") {
      const candidateIds = Array.isArray(review.candidatePersonIds) ? review.candidatePersonIds as string[] : [];
      const rejectedByStaff = candidateIds.includes(decision.personId)
        ? null
        : await tx.backgroundCheckRejectedPairing.findMany({ where: { identityKey: review.entry.identityKey, personId: decision.personId }, select: { id: true } });
      // A person staff rejected for this row is never offered, but staff may still pick them by hand.
      if (!candidateIds.includes(decision.personId) && !(rejectedByStaff && rejectedByStaff.length > 0)) {
        throw new BackgroundCheckOperationError("NOT_A_CANDIDATE", "That person isn't one of this row's candidates.");
      }
      await applyManualMatch(tx, { id: review.entryId, identityKey: review.entry.identityKey }, decision.personId);
    } else {
      await tx.backgroundCheckReview.update({ where: { id: review.id }, data: { dismissedAt: new Date() } });
    }
    await writeAuditLog({
      actorUserId,
      action: decision.type === "match" ? "BACKGROUND_CHECK_REVIEW_MATCHED" : "BACKGROUND_CHECK_REVIEW_DISMISSED",
      entityType: "BackgroundCheckReview",
      entityId: review.id,
      summary: decision.type === "match" ? "Staff matched a Sterling Volunteers row to a person by hand." : "Staff dismissed a Sterling Volunteers review; none of the candidates was right.",
      metadata: { entryId: review.entryId },
    }, tx);
  }).catch((error: unknown) => {
    // The entry or person vanished mid-way (a foreign key or missing row): a 404, not a 500.
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "P2003" || code === "P2025") throw notFound();
    if (code === "P2002" || isWriteConflict(error)) throw listChanged();
    throw error;
  });
}

/**
 * Undo a "none of these" dismissal (#702): the review returns to the open
 * list, as if it had never been dismissed. Only a dismissed review that still
 * exists can be restored; an upload replaces the list wholesale, which removes
 * the review (404). Takes the list lock like the dismissal did.
 */
export async function restoreDismissedBackgroundCheckReview(reviewId: string, actorUserId: string) {
  const prisma = getPrisma();
  const notFound = () => new BackgroundCheckOperationError("REVIEW_NOT_FOUND", "That dismissal can no longer be undone. Refresh the list.");
  await prisma.$transaction(async (tx) => {
    await requireListLock(tx);
    const review = await tx.backgroundCheckReview.findUnique({
      where: { id: reviewId },
      select: { id: true, entryId: true, dismissedAt: true },
    });
    if (!review || !review.dismissedAt) throw notFound();
    await tx.backgroundCheckReview.update({ where: { id: review.id }, data: { dismissedAt: null } });
    await writeAuditLog({
      actorUserId,
      action: "BACKGROUND_CHECK_REVIEW_RESTORED",
      entityType: "BackgroundCheckReview",
      entityId: review.id,
      summary: "Staff undid a Sterling Volunteers review dismissal; the review is open again.",
      metadata: { entryId: review.entryId },
    }, tx);
  }).catch((error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "P2003" || code === "P2025") throw notFound();
    if (code === "P2002" || isWriteConflict(error)) throw listChanged();
    throw error;
  });
}

function listBusy() {
  return new BackgroundCheckOperationError("LIST_BUSY", "Busy, try again in a moment: an upload, a staff decision, or a refresh is running.");
}

/** A serialization failure or deadlock between two writers of the same row (P2034 / 40P01): retry, not a 500. */
function isWriteConflict(error: unknown) {
  const e = error as { code?: unknown; meta?: { code?: unknown } | null; message?: unknown } | null;
  return e?.code === "P2034" || e?.meta?.code === "40P01" || (typeof e?.message === "string" && e.message.includes("40P01"));
}

/** A concurrent refresh or staff decision wrote the same match or identity first (a unique clash): a 409, not a 500. */
function listChanged() {
  return new BackgroundCheckOperationError("LIST_CHANGED", "The list changed while this was saving. Refresh and try again.");
}

export type ManualBackgroundCheckMatch = { id: string; personId: string; personName: string; entryName: string; site: string | null };

/** Every staff match on the current list (#527 N2), so staff can see and undo them. Staff-only. */
export async function listManualBackgroundCheckMatches(): Promise<ManualBackgroundCheckMatch[]> {
  const matches = await getPrisma().backgroundCheckMatch.findMany({
    where: { matchedBy: "MANUAL" },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      personId: true,
      person: { select: { firstName: true, lastName: true } },
      entry: { select: { firstName: true, lastName: true, site: true } },
    },
  });
  return matches.map((match) => ({
    id: match.id,
    personId: match.personId,
    personName: `${match.person.firstName} ${match.person.lastName}`.trim(),
    entryName: `${match.entry.firstName} ${match.entry.lastName}`.trim(),
    site: match.entry.site,
  }));
}

/**
 * Undoes a staff match (#527 N2): the match and any `user_id` identity it
 * remembered go, then the person is refreshed so the automatic rules apply
 * again. Audited, without names.
 */
export async function undoManualBackgroundCheckMatch(matchId: string, actorUserId: string) {
  const personId = await getPrisma().$transaction(async (tx) => {
    await requireListLock(tx);
    const match = await tx.backgroundCheckMatch.findUnique({
      where: { id: matchId },
      select: { id: true, personId: true, entryId: true, matchedBy: true, entry: { select: { identityKey: true } } },
    });
    if (!match) throw new BackgroundCheckOperationError("MATCH_NOT_FOUND", "That match no longer exists. Refresh the list.");
    if (match.matchedBy !== "MANUAL") throw new BackgroundCheckOperationError("NOT_A_MANUAL_MATCH", "Only a match made by hand can be undone here.");
    await tx.backgroundCheckMatch.deleteMany({ where: { id: match.id } });
    if (isRememberedIdentityKey(match.entry.identityKey)) {
      await tx.externalIdentity.deleteMany({
        where: { provider: ROSTER_IMPORT_PROVIDER, providerScope: "", externalId: match.entry.identityKey, personId: match.personId },
      });
    }
    await writeAuditLog({
      actorUserId,
      action: "BACKGROUND_CHECK_MANUAL_MATCH_UNDONE",
      entityType: "BackgroundCheckMatch",
      entityId: match.id,
      summary: "Staff undid a Sterling Volunteers match made by hand.",
      metadata: { entryId: match.entryId },
    }, tx);
    return match.personId;
  }).catch((error: unknown) => {
    if ((error as { code?: unknown } | null)?.code === "P2002") throw listChanged();
    throw error;
  });
  try {
    await refreshBackgroundCheckMatches([personId]);
  } catch (error) {
    logError("Sterling Volunteers match refresh after undo failed", error);
  }
}

// --- Name-only matches, the staff Refresh, and the "why isn't this person matched?" lookup (#598) ---

/**
 * Staff Refresh (#598): re-runs matching for the whole current list under the
 * current rules, so rows already stored are re-matched without a new upload.
 * `MANUAL` and `MIGRATED` matches, staff dismissals, and "not the same
 * person" decisions are kept exactly as they are. Takes the list lock
 * exclusively, without waiting: while an upload, a staff decision, a
 * per-person refresh, or another Refresh holds it, it is refused (`LIST_BUSY`,
 * 409) and nothing changes.
 */
export async function rematchBackgroundCheckList(now = new Date(), actorUserId?: string) {
  await getPrisma().$transaction(async (tx) => {
    if (!(await tryExclusiveListLock(tx))) {
      throw listBusy();
    }
    const current = await latestUpload(tx);
    if (!current) return;
    await backfillNormalizedNames(tx);
    const memoryCounts = await recomputeNameGroups(tx, current.id, null, now);
    if (actorUserId) {
      await writeAuditLog({
        actorUserId,
        action: "BACKGROUND_CHECK_LIST_REFRESHED",
        entityType: "BackgroundCheckUpload",
        entityId: current.id,
        summary: "Staff re-matched the Sterling Volunteers list.",
        metadata: { ...memoryCounts },
      }, tx);
    }
  }, { timeout: 120_000, maxWait: 10_000 }).catch((error: unknown) => {
    if ((error as { code?: unknown } | null)?.code === "P2002") throw listChanged();
    throw error;
  });
}

export type NameOnlyBackgroundCheckMatch = {
  id: string;
  personId: string;
  personName: string;
  /** The person's clubs and churches on file, for the spot check. */
  personSites: string[];
  entryName: string;
  /** The row's own site, which didn't match. */
  site: string | null;
};

/**
 * The matches decided on the name alone (site didn't match) since the last
 * upload, for an informational spot check (#598, #619). Staff-only. Nothing
 * here needs a click to count: a name-only match of a `user_id` row is
 * remembered, so the next upload finds it as `IDENTITY` and it drops off.
 */
export async function listNameOnlyBackgroundCheckMatches(now = new Date()): Promise<NameOnlyBackgroundCheckMatch[]> {
  const prisma = getPrisma();
  const matches = await prisma.backgroundCheckMatch.findMany({
    where: { matchedBy: "NAME_ONLY" },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      personId: true,
      person: { select: { firstName: true, lastName: true } },
      entry: { select: { firstName: true, lastName: true, site: true } },
    },
  });
  if (matches.length === 0) return [];
  const index = await buildCandidateIndex(prisma, now, { personIds: matches.map((match) => match.personId) });
  return matches.map((match) => ({
    id: match.id,
    personId: match.personId,
    personName: `${match.person.firstName} ${match.person.lastName}`.trim(),
    personSites: [...(index.byPerson.get(match.personId)?.siteNames ?? [])].sort(),
    entryName: `${match.entry.firstName} ${match.entry.lastName}`.trim(),
    site: match.entry.site,
  }));
}

/**
 * "Not the same person" (#598): undoes a name-only match. The row goes back
 * to unmatched and staff's decision is remembered as a durable
 * (row identity key, person) pair, so no refresh and no later upload offers
 * that person for that row again (name-only, automatic, or variant). Staff can
 * still match them by hand, which clears the pair. The decision holds nobody
 * else back. Audited, without names.
 */
export async function rejectNameOnlyBackgroundCheckMatch(matchId: string, actorUserId: string) {
  await getPrisma().$transaction(async (tx) => {
    // An upload, a Refresh, or another decision may hold the list: say so plainly.
    if (!(await tryListLock(tx))) throw listBusy();
    const found = await tx.backgroundCheckMatch.findUnique({
      where: { id: matchId },
      select: { entryId: true },
    });
    if (!found) throw new BackgroundCheckOperationError("MATCH_NOT_FOUND", "That match no longer exists. Refresh the list.");
    // Row-lock the entry, then read it again: a per-person refresh that has
    // this row locked finishes first, and one that starts later waits for us.
    await tx.$queryRaw`SELECT "id" FROM "BackgroundCheckEntry" WHERE "id" = ${found.entryId} FOR NO KEY UPDATE`;
    const match = await tx.backgroundCheckMatch.findUnique({
      where: { id: matchId },
      select: { id: true, personId: true, entryId: true, matchedBy: true, entry: { select: { identityKey: true } } },
    });
    if (!match) throw new BackgroundCheckOperationError("MATCH_NOT_FOUND", "That match no longer exists. Refresh the list.");
    // A name-only match, or an `IDENTITY` one that came from a remembered
    // name-only match (its origin marker is the remembered-match row, #619).
    const remembered = await tx.backgroundCheckRememberedMatch.findMany({ where: { identityKey: match.entry.identityKey, personId: match.personId }, select: { id: true } });
    if (match.matchedBy !== "NAME_ONLY" && !(match.matchedBy === "IDENTITY" && remembered.length > 0)) {
      throw new BackgroundCheckOperationError("NOT_A_NAME_ONLY_MATCH", "Only a match made on the name alone can be undone here.");
    }
    const deleted = await tx.backgroundCheckMatch.deleteMany({ where: { entryId: match.entryId, matchedBy: match.matchedBy } });
    if (deleted.count !== 1) throw listChanged();
    // The id remembered for this match (#619) goes too: staff said it is wrong.
    if (isRememberedIdentityKey(match.entry.identityKey)) {
      await tx.externalIdentity.deleteMany({
        where: { provider: ROSTER_IMPORT_PROVIDER, providerScope: "", externalId: match.entry.identityKey, personId: match.personId },
      });
    }
    // The remembered match (#619) goes too.
    const forgotten = await tx.backgroundCheckRememberedMatch.deleteMany({ where: { identityKey: match.entry.identityKey, personId: match.personId } });
    // Remembered by the row's identity key, so it holds across every upload.
    await tx.backgroundCheckRejectedPairing.createMany({
      data: [{ identityKey: match.entry.identityKey, personId: match.personId, rejectedByUserId: actorUserId }],
      skipDuplicates: true,
    });
    await writeAuditLog({
      actorUserId,
      action: "BACKGROUND_CHECK_NAME_ONLY_MATCH_REJECTED",
      entityType: "BackgroundCheckMatch",
      entityId: match.id,
      summary: "Staff said a Sterling Volunteers row matched on the name alone is not the same person.",
      metadata: { entryId: match.entryId, forgotRemembered: forgotten.count },
    }, tx);
  }).catch((error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "P2002" || isWriteConflict(error)) throw listChanged();
    throw error;
  });
}

/**
 * "Match them anyway" (#598): staff undo their own "not the same person" by
 * matching the rejected person to the row by hand. A `MANUAL` match like any
 * other (it holds across refreshes and uploads until staff undo it), and the
 * rejection is cleared. Only for a pair staff actually rejected. Takes the
 * list lock shared, without waiting; audited, without names.
 */
export async function matchRejectedBackgroundCheckPairing(entryId: string, personId: string, actorUserId: string) {
  await getPrisma().$transaction(async (tx) => {
    if (!(await tryListLock(tx))) throw listBusy();
    await tx.$queryRaw`SELECT "id" FROM "BackgroundCheckEntry" WHERE "id" = ${entryId} FOR NO KEY UPDATE`;
    const [entry] = await tx.backgroundCheckEntry.findMany({ where: { id: entryId }, select: { id: true, identityKey: true } });
    if (!entry) throw new BackgroundCheckOperationError("REVIEW_NOT_FOUND", "That row is no longer on the list. Refresh the list.");
    const rejected = await tx.backgroundCheckRejectedPairing.findMany({ where: { identityKey: entry.identityKey, personId }, select: { id: true } });
    if (rejected.length === 0) throw new BackgroundCheckOperationError("NOT_A_CANDIDATE", "Staff haven't rejected that person for this row.");
    await applyManualMatch(tx, entry, personId);
    await writeAuditLog({
      actorUserId,
      action: "BACKGROUND_CHECK_REJECTION_OVERRIDDEN",
      entityType: "BackgroundCheckEntry",
      entityId: entry.id,
      summary: "Staff matched a Sterling Volunteers row by hand to a person they had earlier said it was not.",
      metadata: { entryId: entry.id },
    }, tx);
  }).catch((error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "P2003" || code === "P2025") throw new BackgroundCheckOperationError("REVIEW_NOT_FOUND", "That row or person is no longer on file. Refresh the list.");
    if (code === "P2002" || isWriteConflict(error)) throw listChanged();
    throw error;
  });
}

const MAX_LOOKUP_ROWS = 25;
const MAX_LOOKUP_PEOPLE = 25;

export type BackgroundCheckLookupPair = {
  entryId: string;
  personId: string;
  rowName: string;
  personName: string;
  /** A plain-language reason the two are, or are not, matched. Never a birth date. */
  reason: string;
  /** Set when staff can say "Not the same person" about this match: a name-only match, or a remembered one (#619). */
  rejectMatchId: string | null;
};
export type BackgroundCheckLookup = {
  query: string;
  hasList: boolean;
  rows: Array<{ id: string; name: string; site: string | null; status: string }>;
  people: Array<{ personId: string; name: string; sites: string[]; status: string }>;
  pairs: BackgroundCheckLookupPair[];
  /** Pairs staff said are not the same person, with the ids "Match them anyway" needs. */
  rejected: Array<{ entryId: string; personId: string; rowName: string; personName: string }>;
  truncated: boolean;
};

const MATCH_SOURCE_LABEL: Record<string, string> = {
  IDENTITY: "by a remembered id",
  AUTO: "by name and site, email, or birth date",
  NAME_ONLY: "by name only",
  MANUAL: "by hand",
  MIGRATED: "from before the list",
};

/** The same or a similar name: the same last name, and the same or a similar first name (or none typed). */
function similarName(query: { firstName: string; lastName: string }, other: { firstName: string; lastName: string }) {
  if (matchableName(other.lastName) !== matchableName(query.lastName)) return false;
  if (!query.firstName) return true;
  return matchableName(other.firstName) === matchableName(query.firstName) || firstNameVariant(query.firstName, other.firstName);
}

/** Similar to the typed name under any of its first/last splits ("Mary Van Buren" reads two ways). */
function similarToAnySplit(splits: Array<{ firstName: string; lastName: string }>, other: { firstName: string; lastName: string }) {
  return splits.some((split) => similarName(split, other));
}

async function personsWithLastName(tx: PrismaLike, lastName: string) {
  const compact = matchableName(lastName).replace(/ /g, "");
  if (!compact) return [];
  const rows = await tx.$queryRaw<Array<{ id: string; firstName: string; lastName: string }>>`
    SELECT "id", "firstName", "lastName" FROM "Person"
    WHERE regexp_replace(lower(normalize("lastName", NFKD)), '[^a-z0-9]+', '', 'g') = ${compact}
  `;
  return rows.filter((row) => matchableName(row.lastName) === matchableName(lastName));
}

/**
 * "Why isn't this person matched?" (#598): staff type a name and see the list
 * rows and the roster or registration people with the same or a similar
 * name, and for each pair the reason it did or didn't match. Read-only and
 * staff-only; it reads the same rules matching uses and never returns a
 * birth date (or an email).
 */
export async function lookupBackgroundCheckName(rawQuery: string, now = new Date()): Promise<BackgroundCheckLookup> {
  const prisma = getPrisma();
  const query = rawQuery.replace(/\s+/g, " ").trim().slice(0, 100);
  const empty: BackgroundCheckLookup = { query, hasList: false, rows: [], people: [], pairs: [], rejected: [], truncated: false };
  // A multi-word last name ("Van Buren") can split several ways; search the union.
  const splits = lookupNameSplits(query).filter((split) => matchableName(split.lastName));
  if (splits.length === 0) return empty;
  const lastKeys = new Set(splits.map((split) => matchableName(split.lastName)));
  const latest = await latestUpload(prisma);
  const [rowLists, personLists] = await Promise.all([
    Promise.all([...lastKeys].map((lastKey) => (latest
      ? prisma.backgroundCheckEntry.findMany({
        where: { uploadId: latest.id, normalizedName: { endsWith: lastKey } },
        select: { id: true, identityKey: true, firstName: true, lastName: true, normalizedName: true, email: true, sealedBirthDate: true, site: true },
      })
      : Promise.resolve([])))),
    Promise.all(splits.map((split) => personsWithLastName(prisma, split.lastName))),
  ]);
  const rowCandidates = [...new Map(rowLists.flat().map((row) => [row.id, row])).values()];
  const personCandidates = [...new Map(personLists.flat().map((person) => [person.id, person])).values()];
  const sameLast = rowCandidates.filter((row) => lastKeys.has(matchableName(row.lastName)));
  const rowCounts = countRowsByName(sameLast);
  const namesakes = namesakeCounts(personCandidates);
  const allRows = sameLast.filter((row) => similarToAnySplit(splits, row)).sort((a, b) => a.firstName.localeCompare(b.firstName));
  const allPeople = personCandidates.filter((person) => similarToAnySplit(splits, person)).sort((a, b) => a.firstName.localeCompare(b.firstName));
  const rows = allRows.slice(0, MAX_LOOKUP_ROWS);
  const people = allPeople.slice(0, MAX_LOOKUP_PEOPLE);
  const truncated = allRows.length > rows.length || allPeople.length > people.length;
  if (rows.length === 0 && people.length === 0) return { ...empty, hasList: Boolean(latest) };

  const personIds = people.map((person) => person.id);
  const entryIds = rows.map((row) => row.id);
  const [index, rosterMemberships, matches, reviews, rejected, rememberedMatches] = await Promise.all([
    buildCandidateIndex(prisma, now, { personIds }),
    personIds.length > 0
      ? prisma.clubRosterMember.findMany({
        where: { personId: { in: personIds }, status: "ACTIVE", clubYear: { in: [clubYearChoices(now)[0]!, clubYearFor(now)] } },
        select: { personId: true, attendeeType: true, organization: { select: { name: true } } },
      })
      : Promise.resolve([]),
    prisma.backgroundCheckMatch.findMany({
      where: { OR: [{ entryId: { in: entryIds } }, { personId: { in: personIds } }] },
      select: { id: true, personId: true, entryId: true, matchedBy: true },
    }),
    entryIds.length > 0
      ? prisma.backgroundCheckReview.findMany({
        where: { entryId: { in: entryIds } },
        select: { entryId: true, reason: true, candidatePersonIds: true, dismissedAt: true },
      })
      : Promise.resolve([]),
    rejectedPairingsFor(prisma, rows.map((row) => row.identityKey)),
    rememberedMatchesFor(prisma, rows.map((row) => row.identityKey)),
  ]);
  const matchByEntry = new Map(matches.map((match) => [match.entryId, match]));
  const matchByPerson = new Map(matches.map((match) => [match.personId, match]));
  const reviewByEntry = new Map(reviews.map((review) => [review.entryId, review]));
  const rosterByPerson = new Map<string, Array<{ attendeeType: string; club: string }>>();
  for (const member of rosterMemberships) {
    if (!member.personId) continue;
    const list = rosterByPerson.get(member.personId) ?? [];
    list.push({ attendeeType: member.attendeeType, club: member.organization.name });
    rosterByPerson.set(member.personId, list);
  }
  const fullName = (person: { firstName: string; lastName: string }) => `${person.firstName} ${person.lastName}`.trim();
  const entryById = new Map(rows.map((row) => [row.id, row]));
  const personById = new Map(people.map((person) => [person.id, person]));
  const sitesOf = (personId: string) => [...(index.byPerson.get(personId)?.siteNames ?? [])].sort();
  const matchLabel = (source: string) => MATCH_SOURCE_LABEL[source] ?? source.toLowerCase();

  const rowsOut = rows.map((row) => {
    const match = matchByEntry.get(row.id);
    const review = reviewByEntry.get(row.id);
    const matchedTo = match ? personById.get(match.personId) : undefined;
    return {
      id: row.id,
      name: fullName(row),
      site: row.site,
      status: match
        ? `Matched ${matchLabel(match.matchedBy)}${matchedTo ? ` to ${fullName(matchedTo)}` : " to someone"}`
        : review?.dismissedAt ? "Left unmatched: staff said none of the candidates is right"
          : review ? "Waiting on a staff decision"
            : "Not matched",
    };
  });
  const peopleOut = people.map((person) => {
    const match = matchByPerson.get(person.id);
    const candidate = index.byPerson.has(person.id);
    const roster = rosterByPerson.get(person.id) ?? [];
    const matchedRow = match ? entryById.get(match.entryId) : undefined;
    return {
      personId: person.id,
      name: fullName(person),
      sites: candidate ? sitesOf(person.id) : [...new Set(roster.map((member) => member.club))].sort(),
      status: match
        ? `Matched ${matchLabel(match.matchedBy)} to ${matchedRow ? fullName(matchedRow) : "a row"}`
        : candidate ? "An adult on a roster or registration, not matched"
          : "Not an adult on a current or previous-year club roster or a recent registration",
    };
  });

  const pairs: BackgroundCheckLookupPair[] = [];
  for (const row of rows) {
    for (const person of people) {
      if (matchableName(row.lastName) !== matchableName(person.lastName)) continue;
      const sameFirst = matchableName(row.firstName) === matchableName(person.firstName);
      if (!sameFirst && !firstNameVariant(row.firstName, person.firstName)) continue;
      const reasons: string[] = [];
      const match = matchByEntry.get(row.id);
      const review = reviewByEntry.get(row.id);
      const candidate = index.byPerson.get(person.id);
      const roster = rosterByPerson.get(person.id) ?? [];
      const reviewNamesPerson = Boolean(review && !review.dismissedAt && Array.isArray(review.candidatePersonIds) && (review.candidatePersonIds as string[]).includes(person.id));
      if (match?.personId === person.id) {
        reasons.push(`Matched ${matchLabel(match.matchedBy)}.`);
      } else if (match) {
        reasons.push("This row is already matched to someone else.");
      } else if (rejected.get(row.identityKey)?.has(person.id)) {
        reasons.push("Staff said this row is not the same person as this one, so they are not matched. That holds across uploads until staff match them by hand.");
      } else if (review?.dismissedAt) {
        reasons.push("Staff already said this row is not the same person (or none of the candidates is right), so it stays unmatched until the next upload.");
      } else if (!sameFirst) {
        reasons.push(`The first name differs (row: ${row.firstName}, person: ${person.firstName}).`);
        if (reviewNamesPerson) reasons.push("It is a similar first name, so it was sent to review.");
        else if (candidate) reasons.push("It is a similar first name, so Refresh suggests it for review; it is never matched automatically.");
        else reasons.push("This person is also not an adult on a current or previous-year club roster or a recent registration.");
      } else if (!candidate) {
        const onRoster = roster.length > 0 ? ` (on the ${roster.map((member) => member.club).join(", ")} roster as ${roster.map((member) => member.attendeeType.toLowerCase()).join(", ")})` : "";
        reasons.push(`This person is not an adult on a current or previous-year club roster or a recent registration${onRoster}.`);
      } else if (matchByPerson.has(person.id)) {
        reasons.push("This person is already matched to another row.");
      } else if (reviewNamesPerson) {
        reasons.push(`Sent to review: ${review!.reason}`);
      } else {
        const rowName = row.normalizedName ?? matchableName(fullName(row));
        if (candidatesForEntry(row, [candidate], index.directoryStems).length > 0) {
          reasons.push("The name and site agree; it matches on the next Refresh.");
        } else if (contradictsEntry(row, candidate)) {
          reasons.push("The email or birth date on the row disagrees with this person's, so they are not matched.");
        } else {
          const sites = sitesOf(person.id);
          reasons.push(`The site differs (row: ${row.site ?? "none listed"}; person: ${sites.length > 0 ? sites.join(", ") : "none on file"}).`);
          if ((index.byName.get(rowName) ?? []).length > 1) reasons.push("More than one candidate has this name, and nothing separates them.");
          else if ((rowCounts.get(rowName) ?? 1) > 1) reasons.push("More than one row on the list has this name.");
          else if ((namesakes.get(rowName) ?? 1) > 1) reasons.push("Another person on file has the same name.");
          else reasons.push("The name is unique, so it matches by name only on the next Refresh.");
        }
      }
      const rememberedHere = rememberedMatches.get(row.identityKey)?.personId === person.id;
      const rejectMatchId = match?.personId === person.id && (match.matchedBy === "NAME_ONLY" || (match.matchedBy === "IDENTITY" && rememberedHere)) ? match.id : null;
      pairs.push({ entryId: row.id, personId: person.id, rowName: fullName(row), personName: fullName(person), reason: reasons.join(" "), rejectMatchId });
    }
  }
  const rejectedOut = rows.flatMap((row) => people
    .filter((person) => rejected.get(row.identityKey)?.has(person.id))
    .map((person) => ({ entryId: row.id, personId: person.id, rowName: fullName(row), personName: fullName(person) })));
  return { query, hasList: true, rows: rowsOut, people: peopleOut, pairs, rejected: rejectedOut, truncated };
}

/** No review waiting on staff: none at all, or one staff dismissed ("none of these"). */
const NO_OPEN_REVIEW = { OR: [{ review: null }, { review: { dismissedAt: { not: null } } }] } satisfies Prisma.BackgroundCheckEntryWhereInput;

/** List entries under the current upload that match no one yet (dismissed ones included) — visible to staff, not guessed. */
export async function listUnmatchedBackgroundCheckEntries() {
  const prisma = getPrisma();
  const latest = await latestUpload(prisma);
  if (!latest) return [];
  return prisma.backgroundCheckEntry.findMany({
    where: { uploadId: latest.id, match: null, ...NO_OPEN_REVIEW },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    select: { id: true, firstName: true, lastName: true, site: true, complianceStatus: true, checkedOn: true, expiresOn: true },
  });
}

// --- Read path: everywhere a person's compliance is looked up ---

type StoredCheck = {
  expiresOn: string | null;
  complianceStatus?: BackgroundComplianceStatus | null;
  issuesNote?: string | null;
};

type LookupSubject = {
  personId: string;
  firstName: string;
  lastName: string;
  emails: Iterable<string>;
  birthDates: Iterable<string>;
  sites: Array<string | null | undefined>;
};

/**
 * Read-time matching for people the cache has no match for yet (#527 B5):
 * someone added by any write path is matched at lookup even before a
 * refresh has run. A fixed number of queries per page, however many people
 * it shows:
 *
 * 1. the latest upload's entries in the page's name groups that have no
 *    match and no review at all — not an open one, and not one staff
 *    dismissed ("none of these is right" is never overridden here);
 * 2. only if there are any: everyone on file in those name groups
 *    (`personIdsNamed`) and their evidence (the scoped candidate index),
 *    so an entry is accepted only when no *other* person anywhere could
 *    also be it — not just no one else on this page.
 *
 * The page's own evidence (emails, a form or roster birth date, the club or
 * church) is added to its people's. An entry more than one person could be,
 * or a person more than one entry could be, is left unmatched — never
 * guessed; the next refresh turns it into a review.
 */
async function lookupUncachedChecks(prisma: PrismaLike, subjects: LookupSubject[], now = new Date()): Promise<Map<string, StoredCheck>> {
  const found = new Map<string, StoredCheck>();
  const pagePeople = new Map<string, NameCandidate>();
  for (const subject of subjects) {
    if (!subject.firstName && !subject.lastName) continue;
    rememberCandidate(pagePeople, subject.personId, subject.firstName, subject.lastName, {
      emails: subject.emails, birthDates: subject.birthDates, sites: subject.sites,
    });
  }
  const pageNames = [...groupByName(pagePeople).keys()];
  if (pageNames.length === 0) return found;
  const fetched = await prisma.backgroundCheckEntry.findMany({
    where: { normalizedName: { in: pageNames }, match: null, review: null },
    select: {
      id: true, uploadId: true, identityKey: true, normalizedName: true, email: true, sealedBirthDate: true, site: true,
      complianceStatus: true, expiresOn: true, issuesNote: true, upload: { select: { createdAt: true } },
    },
  });
  if (fetched.length === 0) return found;
  // Only the latest upload's entries are "the list" (an upload deletes the rest).
  const latest = fetched.reduce((best, entry) => (
    entry.upload.createdAt > best.upload.createdAt || (entry.upload.createdAt.getTime() === best.upload.createdAt.getTime() && entry.uploadId > best.uploadId) ? entry : best
  ));
  const entries = fetched.filter((entry) => entry.uploadId === latest.uploadId && entry.normalizedName);

  // Everyone on file who shares these names, not just this page's people.
  const groupNames = [...new Set(entries.map((entry) => entry.normalizedName!))];
  const namedIds = await personIdsNamed(prisma, groupNames);
  const index = await buildCandidateIndex(prisma, now, { personIds: namedIds });
  const everyone = new Map(index.byPerson);
  for (const person of pagePeople.values()) {
    const known = everyone.get(person.personId);
    if (!known) {
      everyone.set(person.personId, person);
      continue;
    }
    for (const email of person.emails) known.emails.add(email);
    for (const birthDate of person.birthDates) known.birthDates.add(birthDate);
    for (const site of person.siteNames) known.siteNames.add(site);
  }
  // A person on file in the name group with no roster or registration
  // evidence can't be a candidate by the rules, so isn't one here either.
  const byName = groupByName(everyone);

  // People staff said a row is not never match it here either (#598).
  const rejected = await rejectedPairingsFor(prisma, entries.map((entry) => entry.identityKey));
  const entriesByPerson = new Map<string, Array<(typeof entries)[number]>>();
  for (const entry of entries) {
    const rejectedHere = rejected.get(entry.identityKey);
    const candidates = candidatesForEntry(entry, (byName.get(entry.normalizedName!) ?? []).filter((candidate) => !rejectedHere?.has(candidate.personId)), index.directoryStems);
    if (candidates.length !== 1 || !pagePeople.has(candidates[0]!.personId)) continue;
    const list = entriesByPerson.get(candidates[0]!.personId) ?? [];
    list.push(entry);
    entriesByPerson.set(candidates[0]!.personId, list);
  }
  for (const [personId, list] of entriesByPerson) {
    if (list.length !== 1) continue;
    const entry = list[0]!;
    found.set(personId, { complianceStatus: entry.complianceStatus, expiresOn: entry.expiresOn, issuesNote: entry.issuesNote });
  }
  return found;
}

/**
 * Counts for the system administrator's page. Sterling checks go by date; roster checks by their mark.
 * `current` and `expiringSoon` are disjoint (#702): "current" is clear with no expiry in the next 60
 * days, so the two never count the same check twice.
 */
export async function backgroundCheckSummary(today = calendarDateInEventTimeZone(new Date(), "America/Chicago")) {
  const soon = new Date(`${today}T12:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + 60);
  const soonDate = soon.toISOString().slice(0, 10);
  const prisma = getPrisma();
  const latestUploadForCounts = await latestUpload(prisma);
  const [currentByDate, currentByMark, soonByDate, soonByMark, expired, notCompliant, latestMatch, reviewCount, unmatchedCount, youthEvents] = await Promise.all([
    prisma.backgroundCheckMatch.count({ where: { entry: { complianceStatus: null, expiresOn: { gt: soonDate } } } }),
    prisma.backgroundCheckMatch.count({ where: { entry: { complianceStatus: "CLEAR" } } }),
    prisma.backgroundCheckMatch.count({ where: { entry: { complianceStatus: null, expiresOn: { gte: today, lte: soonDate } } } }),
    prisma.backgroundCheckMatch.count({ where: { entry: { complianceStatus: "FLAGGED" } } }),
    prisma.backgroundCheckMatch.count({ where: { entry: { complianceStatus: null, expiresOn: { lt: today } } } }),
    prisma.backgroundCheckMatch.count({ where: { entry: { complianceStatus: "NOT_COMPLIANT" } } }),
    prisma.backgroundCheckMatch.findFirst({ orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
    prisma.backgroundCheckReview.count({ where: { dismissedAt: null } }),
    latestUploadForCounts ? prisma.backgroundCheckEntry.count({ where: { uploadId: latestUploadForCounts.id, match: null, ...NO_OPEN_REVIEW } }) : Promise.resolve(0),
    prisma.event.findMany({
      where: { checksAdultBackgrounds: true, endsAt: { gte: new Date() } },
      orderBy: { startsAt: "asc" },
      select: { id: true, name: true, startsAt: true, timezone: true },
    }),
  ]);
  const events = await Promise.all(youthEvents.map(async (event) => {
    const flags = await listEventBackgroundFlags(event.id);
    return {
      id: event.id,
      name: event.name,
      startsOn: calendarDateInEventTimeZone(event.startsAt, event.timezone),
      adults: flags?.adults ?? 0,
      needed: flags?.people.length ?? 0,
    };
  }));
  const lastRecordedAt = [latestUploadForCounts?.createdAt, latestMatch?.updatedAt].filter((value): value is Date => Boolean(value)).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  return {
    current: currentByDate + currentByMark,
    expiringSoon: soonByDate + soonByMark,
    notCurrent: expired + notCompliant,
    reviewCount,
    unmatchedCount,
    lastRecordedAt: lastRecordedAt?.toISOString() ?? null,
    events,
  };
}

export type BackgroundFlag = {
  attendeeId: string;
  personId: string;
  firstName: string;
  lastName: string;
  attendeeType: string;
  clubName: string | null;
  organizationId: string | null;
  confirmationCode: string;
  registrationId: string;
  state: Exclude<BackgroundCheckState, "CURRENT">;
  expiresOn: string | null;
  /** The list's issues column as stored (#544): only when the caller asked for notes (`includeNotes`, system administrators only, #427); otherwise null. */
  issuesNote: string | null;
  /** The issues text as readable reasons for staff ("Marked Non-Driver", ...): same audience as `issuesNote`, empty otherwise. */
  issueReasons: string[];
};

/**
 * Every adult registered for a youth or children's event who has no current
 * check through the event's last day. Null when the event doesn't check.
 * Staff and event managers only; never shown to clubs. `includeNotes` adds each
 * person's issues text, and must be decided by the caller from who is asking.
 */
export async function listEventBackgroundFlags(eventId: string, options: { organizationId?: string; includeNotes?: boolean } = {}) {
  const prisma = getPrisma();
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { checksAdultBackgrounds: true, startsAt: true, endsAt: true, timezone: true },
  });
  if (!event?.checksAdultBackgrounds) return null;
  const eventDate = calendarDateInEventTimeZone(event.startsAt, event.timezone);
  const lastDay = calendarDateInEventTimeZone(event.endsAt, event.timezone);
  const todayInChicago = calendarDateInEventTimeZone(new Date(), "America/Chicago");
  const attendees = await prisma.registrationAttendee.findMany({
    where: {
      eventId,
      registration: {
        status: { in: [...activeRegistrationStatuses] },
        ...(options.organizationId ? { clubRegistration: { organizationId: options.organizationId } } : {}),
      },
    },
    orderBy: [{ person: { lastName: "asc" } }, { person: { firstName: "asc" } }],
    select: {
      id: true,
      personId: true,
      attendeeType: true,
      profileSnapshot: true,
      formResponses: true,
      person: {
        select: {
          firstName: true,
          lastName: true,
          ...personEmailSelect,
          backgroundCheckMatch: { select: { entry: { select: { expiresOn: true, complianceStatus: true, issuesNote: true } } } },
        },
      },
      registration: {
        select: {
          id: true,
          confirmationCode: true,
          clubRegistration: { select: { organizationId: true, organization: clubSelect } },
          // A registration at a location of a multi-location event is checked through
          // that location's last day (#413); without one, the event's last day.
          location: { select: { lastDay: true } },
        },
      },
    },
  });
  const rosterIds = attendees
    .map((attendee) => (attendee.profileSnapshot as { clubRosterMemberId?: unknown } | null)?.clubRosterMemberId)
    .filter((id): id is string => typeof id === "string");
  const rosterTypes = new Map((rosterIds.length > 0
    ? await prisma.clubRosterMember.findMany({ where: { id: { in: rosterIds } }, select: { id: true, attendeeType: true } })
    : []).map((member) => [member.id, member.attendeeType]));

  const adultAttendees = attendees.filter((attendee) => {
    const snapshot = (attendee.profileSnapshot ?? {}) as { ageOnEventDate?: unknown; clubRosterMemberId?: unknown };
    const responses = (attendee.formResponses ?? {}) as Record<string, unknown>;
    const age = attendeeAge(snapshot, responses, eventDate);
    const rosterAttendeeType = typeof snapshot.clubRosterMemberId === "string" ? rosterTypes.get(snapshot.clubRosterMemberId) ?? null : null;
    return attendeeIsAdult({ ageOnEventDate: age, rosterAttendeeType, attendeeType: attendee.attendeeType });
  });
  const uncached = await lookupUncachedChecks(prisma, adultAttendees
    .filter((attendee) => !attendee.person.backgroundCheckMatch)
    .map((attendee) => {
      const snapshot = (attendee.profileSnapshot ?? {}) as { email?: unknown };
      const responses = (attendee.formResponses ?? {}) as Record<string, unknown>;
      const emails = personEmails(attendee.person);
      if (typeof snapshot.email === "string" && snapshot.email) emails.add(snapshot.email.trim().toLowerCase());
      const birthDate = formBirthDate(responses);
      const club = attendee.registration.clubRegistration?.organization;
      return {
        personId: attendee.personId,
        firstName: attendee.person.firstName,
        lastName: attendee.person.lastName,
        emails,
        birthDates: birthDate ? [birthDate] : [],
        sites: [club?.name, club?.parentOrganization?.name],
      };
    }));

  const people: BackgroundFlag[] = [];
  for (const attendee of adultAttendees) {
    const snapshot = (attendee.profileSnapshot ?? {}) as { firstName?: unknown; lastName?: unknown };
    const check: StoredCheck | null = attendee.person.backgroundCheckMatch?.entry ?? uncached.get(attendee.personId) ?? null;
    const state = backgroundCheckState(check, attendee.registration.location?.lastDay ?? lastDay);
    if (state === "CURRENT") continue;
    const club = attendee.registration.clubRegistration;
    people.push({
      attendeeId: attendee.id,
      personId: attendee.personId,
      firstName: typeof snapshot.firstName === "string" && snapshot.firstName ? snapshot.firstName : attendee.person.firstName,
      lastName: typeof snapshot.lastName === "string" && snapshot.lastName ? snapshot.lastName : attendee.person.lastName,
      attendeeType: attendee.attendeeType,
      clubName: club?.organization.name ?? null,
      organizationId: club?.organizationId ?? null,
      confirmationCode: attendee.registration.confirmationCode,
      registrationId: attendee.registration.id,
      state,
      expiresOn: check?.expiresOn ?? null,
      issuesNote: options.includeNotes ? check?.issuesNote?.trim() || null : null,
      issueReasons: options.includeNotes ? describeIssues(check?.issuesNote, todayInChicago) : [],
    });
  }
  return { adults: adultAttendees.length, people, lastDay };
}

/** Just the attendee IDs to flag, for rosters and check-in. Empty when the event doesn't check. */
export async function backgroundFlaggedAttendeeIds(eventId: string) {
  const flags = await listEventBackgroundFlags(eventId);
  return new Set(flags?.people.map((person) => person.attendeeId) ?? []);
}

export type RosterMemberForCheck = {
  personId: string | null;
  sealedBirthDate?: string | null;
  organization?: { name: string; parentOrganization?: { name: string } | null } | null;
  person: {
    firstName: string;
    lastName: string;
    normalizedEmail?: string | null;
    attendeeAccountLinks?: Array<{ account: { email: string } }> | null;
    backgroundCheckMatch?: unknown;
  } | null;
};

/** The roster `select` a caller needs for `uncachedChecksForRosterMembers`. */
export const rosterMemberCheckEvidenceSelect = {
  sealedBirthDate: true,
  organization: clubSelect,
} as const;
export const personCheckEvidenceSelect = personEmailSelect;

/**
 * Read-time checks for roster members the cache has no match for yet
 * (#527): the same lookup the club roster uses, for any roster-shaped page
 * (any page that lists people by roster row). Keyed by person id.
 */
export async function uncachedChecksForRosterMembers(members: RosterMemberForCheck[], prisma: PrismaLike = getPrisma()) {
  return lookupUncachedChecks(prisma, members
    .filter((member) => member.personId && member.person && !member.person.backgroundCheckMatch)
    .map((member) => {
      const birthDate = openEntryBirthDate(member.sealedBirthDate ?? null);
      return {
        personId: member.personId!,
        firstName: member.person!.firstName,
        lastName: member.person!.lastName,
        emails: personEmails(member.person!),
        birthDates: birthDate ? [birthDate] : [],
        sites: [member.organization?.name, member.organization?.parentOrganization?.name],
      };
    }));
}

/**
 * A club page's compliance status per adult roster member (#427): Clear,
 * Expiring soon, Not in compliance, or No record, keyed by roster member id.
 * `includeNotes` must be decided by the caller from who is asking — the note
 * is for system administrators and, for a club in their scope, an Area
 * Coordinator (#443), and a club director never receives it, not even a blank one
 * to hide.
 */
export async function clubRosterComplianceStatuses(
  organizationId: string,
  clubYear: string,
  options: { includeNotes: boolean },
) {
  const today = calendarDateInEventTimeZone(new Date(), "America/Chicago");
  const prisma = getPrisma();
  const members = await prisma.clubRosterMember.findMany({
    where: { organizationId, clubYear, status: "ACTIVE", attendeeType: { in: ["ADULT", "STAFF"] } },
    select: {
      id: true,
      personId: true,
      sealedBirthDate: true,
      organization: clubSelect,
      person: {
        select: {
          firstName: true,
          lastName: true,
          ...personEmailSelect,
          backgroundCheckMatch: { select: { entry: { select: { complianceStatus: true, expiresOn: true, issuesNote: true } } } },
        },
      },
    },
  });
  const uncached = await uncachedChecksForRosterMembers(members, prisma);
  const statuses: Record<string, { state: ClubComplianceState; note: string | null; reasons: string[] }> = {};
  let notInCompliance = 0;
  let expiringSoon = 0;
  let missing = 0;
  for (const member of members) {
    const check: StoredCheck | null = member.person?.backgroundCheckMatch?.entry
      ?? (member.personId ? uncached.get(member.personId) : undefined)
      ?? null;
    const state = clubComplianceState(check, today);
    if (state === "NOT_COMPLIANT") notInCompliance += 1;
    if (state === "FLAGGED") expiringSoon += 1;
    if (state === "NO_RECORD") missing += 1;
    statuses[member.id] = {
      state,
      note: options.includeNotes ? check?.issuesNote?.trim() || null : null,
      reasons: options.includeNotes ? describeIssues(check?.issuesNote, today) : [],
    };
  }
  return { statuses, notInCompliance, expiringSoon, missing };
}

/**
 * Just the reminder counts behind club home "What's next" and the club
 * overview (#479) — never the per-member statuses, so a caller that only
 * needs the reminder figures (the cross-club Area Coordinator overview, club
 * home) gets counts without any name or note attached. An Area Coordinator's
 * single-club page uses the per-member statuses instead (#443).
 */
export async function clubComplianceReminderCounts(organizationId: string, clubYear: string) {
  const { notInCompliance, expiringSoon, missing } = await clubRosterComplianceStatuses(organizationId, clubYear, { includeNotes: false });
  return { notInCompliance, expiringSoon, missing };
}

/**
 * Reminder counts for many clubs at once (#657), for the Area Coordinator's
 * cross-club overview; the same numbers `clubComplianceReminderCounts` gives
 * per club. One identity-free query reads each adult's organization, person id
 * and cached check status. Only the adults with a person but no cached match
 * (the cache is best-effort, #527) take one follow-up query across all clubs
 * for the evidence `uncachedChecksForRosterMembers` needs, then that lookup
 * runs once for them, exactly as the per-club function would. That evidence
 * stays inside this function: only counts are returned.
 */
export async function clubsComplianceReminderCounts(organizationIds: string[], clubYear: string) {
  const today = calendarDateInEventTimeZone(new Date(), "America/Chicago");
  const prisma = getPrisma();
  const members = await prisma.clubRosterMember.findMany({
    where: { organizationId: { in: organizationIds }, clubYear, status: "ACTIVE", attendeeType: { in: ["ADULT", "STAFF"] } },
    select: {
      id: true,
      organizationId: true,
      personId: true,
      person: { select: { backgroundCheckMatch: { select: { entry: { select: { complianceStatus: true, expiresOn: true } } } } } },
    },
  });
  const uncachedIds = members.filter((member) => member.personId && member.person && !member.person.backgroundCheckMatch).map((member) => member.id);
  let uncached = new Map<string, StoredCheck>();
  if (uncachedIds.length > 0) {
    const evidence = await prisma.clubRosterMember.findMany({
      where: { id: { in: uncachedIds } },
      select: {
        personId: true,
        sealedBirthDate: true,
        organization: clubSelect,
        person: { select: { firstName: true, lastName: true, ...personEmailSelect } },
      },
    });
    uncached = await uncachedChecksForRosterMembers(evidence, prisma);
  }
  const counts = new Map<string, { missing: number; notInCompliance: number; expiringSoon: number }>(
    organizationIds.map((id) => [id, { missing: 0, notInCompliance: 0, expiringSoon: 0 }]),
  );
  for (const member of members) {
    const check: StoredCheck | null = member.person?.backgroundCheckMatch?.entry
      ?? (member.personId ? uncached.get(member.personId) : undefined)
      ?? null;
    const state = clubComplianceState(check, today);
    const row = counts.get(member.organizationId);
    if (!row) continue;
    if (state === "NOT_COMPLIANT") row.notInCompliance += 1;
    if (state === "FLAGGED") row.expiringSoon += 1;
    if (state === "NO_RECORD") row.missing += 1;
  }
  return counts;
}

/**
 * Club home's reminder counts (#479): the same gate as the roster's own
 * compliance column below (directors and deputies only), so the two can't drift.
 */
export async function clubPortalComplianceReminderCounts(
  organizationId: string,
  clubYear: string,
  capabilities: Pick<ClubCapabilities, "seeBirthDates">,
) {
  if (!capabilities.seeBirthDates) return null;
  return clubComplianceReminderCounts(organizationId, clubYear);
}

/**
 * The club portal's own roster (#427): compliance status for a director or
 * deputy only (the same people who see full birth dates), never a note, and
 * nothing at all for a registrar.
 */
export async function clubPortalComplianceStatuses(
  organizationId: string,
  clubYear: string,
  capabilities: Pick<ClubCapabilities, "seeBirthDates">,
) {
  if (!capabilities.seeBirthDates) return undefined;
  return (await clubRosterComplianceStatuses(organizationId, clubYear, { includeNotes: false })).statuses;
}

export { ROSTER_IMPORT_PROVIDER };

/**
 * Whether one person has a Sterling Volunteers check that is current today
 * (#833): the cached match, else the same read-time match the rosters use. The
 * answer is one of the display states only; no dates, notes or list rows leave
 * here. A roster import's mark decides when the list row has one (Clear and "!"
 * are current), otherwise the Sterling expiration date does.
 */
export async function currentCheckStateForPerson(personId: string, now = new Date()): Promise<BackgroundCheckState> {
  const prisma = getPrisma();
  const person = await prisma.person.findUnique({
    where: { id: personId },
    select: {
      firstName: true,
      lastName: true,
      ...personEmailSelect,
      backgroundCheckMatch: { select: { entry: { select: { expiresOn: true, complianceStatus: true } } } },
    },
  });
  if (!person) return "MISSING";
  let check: StoredCheck | null = person.backgroundCheckMatch?.entry ?? null;
  if (!check) {
    const found = await lookupUncachedChecks(prisma, [{
      personId,
      firstName: person.firstName,
      lastName: person.lastName,
      emails: personEmails(person),
      birthDates: [],
      sites: [],
    }], now);
    check = found.get(personId) ?? null;
  }
  return backgroundCheckState(check, calendarDateInEventTimeZone(now, "America/Chicago"));
}

/** The typed name carries the person's first and last name (a middle name or initial doesn't matter). */
function namesAgree(typed: string, person: { firstName: string; lastName: string }) {
  const words = new Set(nameWords(typed));
  const wanted = [...nameWords(person.firstName), ...nameWords(person.lastName)];
  return wanted.length > 0 && wanted.every((word) => words.has(word));
}

export type DirectorBackgroundMatch = {
  state: ClubComplianceState;
  /** The email reached more than one person; the least favorable state is shown. */
  ambiguous: boolean;
  /** The email matched someone, but none of them has the typed director's name. */
  nameMismatch: boolean;
};

/**
 * The Sterling Volunteers status of each applying director (#817), keyed by
 * `directorMatchKey(email, name)`: Clear, Expiring soon, Not in compliance or No record, the
 * same labels a club roster shows. A director is matched to an existing person
 * by email: the person's own email, or the email of an attendee account linked
 * to them. Someone who matches nobody is "No record". The check is the cached
 * match, else the same read-time match the rosters use.
 *
 * An email can reach more than one person, and the result is then marked
 * ambiguous. The matched people's names are compared with the name the
 * applicant typed: the status shown is that of the people who agree (the least
 * favorable if several), and when none agrees it is No record with the result
 * marked as a name mismatch, so a stranger's check is never shown as theirs.
 * It is a flag for staff to review, never a block, and it returns no names,
 * notes or dates.
 */
export async function directorBackgroundStatesByEmail(
  directors: Array<{ email: string; name: string }>,
  now = new Date(),
  prisma: PrismaLike = getPrisma(),
): Promise<Map<string, DirectorBackgroundMatch>> {
  const typedNames = new Map<string, string[]>();
  for (const director of directors) {
    const email = director.email.trim().toLowerCase();
    if (!email) continue;
    typedNames.set(email, [...(typedNames.get(email) ?? []), director.name]);
  }
  const wanted = [...typedNames.keys()];
  const results = new Map<string, DirectorBackgroundMatch>(
    directors
      .filter((director) => director.email.trim())
      .map((director) => [directorMatchKey(director.email, director.name), { state: "NO_RECORD", ambiguous: false, nameMismatch: false }]),
  );
  if (wanted.length === 0) return results;
  const today = calendarDateInEventTimeZone(now, "America/Chicago");
  const people = await prisma.person.findMany({
    where: {
      OR: [
        { normalizedEmail: { in: wanted } },
        { attendeeAccountLinks: { some: { account: { email: { in: wanted } } } } },
      ],
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      ...personEmailSelect,
      backgroundCheckMatch: { select: { entry: { select: { complianceStatus: true, expiresOn: true } } } },
    },
  });
  const uncached = await lookupUncachedChecks(prisma, people
    .filter((person) => !person.backgroundCheckMatch)
    .map((person) => ({
      personId: person.id,
      firstName: person.firstName,
      lastName: person.lastName,
      emails: personEmails(person),
      birthDates: [],
      sites: [],
    })), now);
  // Least favorable first: a missing record is worse than a clear one, and an expired check is worst.
  const favor: Record<ClubComplianceState, number> = { NOT_COMPLIANT: 0, NO_RECORD: 1, FLAGGED: 2, CLEAR: 3 };
  const byEmail = new Map<string, Array<{ state: ClubComplianceState; person: { firstName: string; lastName: string } }>>();
  for (const person of people) {
    const check: StoredCheck | null = person.backgroundCheckMatch?.entry ?? uncached.get(person.id) ?? null;
    const state = clubComplianceState(check, today);
    for (const email of personEmails(person)) {
      if (!typedNames.has(email)) continue;
      byEmail.set(email, [...(byEmail.get(email) ?? []), { state, person }]);
    }
  }
  for (const [email, matches] of byEmail) {
    // One result per typed name: two applications can share an email and carry different names.
    for (const name of new Set(typedNames.get(email) ?? [])) {
      const agreeing = matches.filter((match) => namesAgree(name, match.person));
      // Someone else's check is never shown as the applicant's: with no matching name the status is No record.
      // Among people with the typed name, the least favorable status wins (a single one is simply theirs).
      const state: ClubComplianceState = agreeing.length === 0
        ? "NO_RECORD"
        : agreeing.reduce((least, match) => (favor[match.state] < favor[least.state] ? match : least)).state;
      results.set(directorMatchKey(email, name), { state, ambiguous: matches.length > 1, nameMismatch: agreeing.length === 0 });
    }
  }
  return results;
}
