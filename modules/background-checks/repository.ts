import "server-only";

import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { logError, logInfo } from "@/lib/logger";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { openBirthDate, sealBirthDate } from "@/modules/club-rosters/birth-dates";
import { ageOn, clubYearFor } from "@/modules/club-rosters/domain";
import type { ClubCapabilities } from "@/modules/organizations/director-grants-domain";
import { activeRegistrationStatuses, calendarDateInEventTimeZone } from "@/modules/events/lifecycle";
import { BackgroundCheckOperationError } from "@/modules/background-checks/errors";
import {
  ageFromAnswer,
  attendeeIsAdult,
  backgroundCheckState,
  clubComplianceState,
  dedupeListRows,
  isRememberedIdentityKey,
  matchableName,
  matchesSite,
  normalizeCheckDate,
  type BackgroundCheckListRow,
  type BackgroundCheckState,
  type ClubComplianceState,
  type BackgroundComplianceStatus,
} from "@/modules/background-checks/domain";

/**
 * Background checks (#388, #427, #527): one stored list, fed by either CSV
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
const DERIVED_SOURCES = ["AUTO", "IDENTITY"] as const;
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

type NameCandidate = { personId: string; name: string; emails: Set<string>; birthDates: Set<string>; siteNames: Set<string> };
type NameIndex = { byName: Map<string, NameCandidate[]>; byPerson: Map<string, NameCandidate> };

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
    entry = { personId, name: `${firstName} ${lastName}`.trim(), emails: new Set(), birthDates: new Set(), siteNames: new Set() };
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
 * Every adult on a current club roster, or registered for an event upcoming
 * or ended in the last 12 months, with their known emails, birth dates, and
 * club/church names — the candidate pool matching draws from. Built once for
 * a full pass over the whole list, or scoped to the people who share a name
 * group for a targeted refresh, so neither path scans more than it needs.
 */
async function buildCandidateIndex(tx: PrismaLike, now: Date, scope?: { personIds: string[] }): Promise<NameIndex> {
  if (scope && scope.personIds.length === 0) return { byName: new Map(), byPerson: new Map() };
  const clubYear = clubYearFor(now);
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - REGISTRATION_LOOKBACK_MONTHS);
  const today = calendarDateInEventTimeZone(now, "America/Chicago");

  const [rosterMembers, attendees] = await Promise.all([
    tx.clubRosterMember.findMany({
      where: { clubYear, status: "ACTIVE", attendeeType: { in: ["ADULT", "STAFF"] }, personId: scope ? { in: scope.personIds } : { not: null } },
      select: {
        personId: true,
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
  ]);

  const byPerson = new Map<string, NameCandidate>();
  for (const member of rosterMembers) {
    if (!member.personId || !member.person) continue;
    const birthDate = openEntryBirthDate(member.sealedBirthDate);
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
  return { byName: groupByName(byPerson), byPerson };
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
async function personIdsNamed(tx: PrismaLike, names: string[]) {
  const compacts = [...new Set(names.map((name) => name.replace(/ /g, "")).filter(Boolean))];
  if (compacts.length === 0) return [];
  const rows = await tx.$queryRaw<Array<{ id: string; firstName: string; lastName: string }>>`
    SELECT "id", "firstName", "lastName" FROM "Person"
    WHERE ${Prisma.raw(PERSON_COMPACT_NAME_SQL)} = ANY(${compacts}::text[])
  `;
  const wanted = new Set(names);
  return rows.filter((row) => wanted.has(matchableName(`${row.firstName} ${row.lastName}`))).map((row) => row.id);
}

type EntryForMatch = { id: string; identityKey: string; normalizedName: string | null; email: string | null; sealedBirthDate: string | null; site: string | null };
type MatchResult = { entryId: string; personId: string; identityKey: string; matchedBy: "IDENTITY" | "AUTO" };
type ReviewResult = { entryId: string; reason: string; candidatePersonIds: string[] };

const entryForMatchSelect = { id: true, identityKey: true, normalizedName: true, email: true, sealedBirthDate: true, site: true } as const;

/** Candidates for one entry from its name group: name plus one of email, birth date, or site. */
function candidatesForEntry(entry: Pick<EntryForMatch, "email" | "sealedBirthDate" | "site">, pool: NameCandidate[]): NameCandidate[] {
  const birthDate = openEntryBirthDate(entry.sealedBirthDate);
  const email = entry.email?.toLowerCase() ?? null;
  return pool.filter((candidate) => (
    (email && candidate.emails.has(email))
    || (birthDate && candidate.birthDates.has(birthDate))
    || (entry.site && matchesSite(entry.site, candidate.siteNames))
  ));
}

/**
 * Matches a set of entries against people, the same rules every time (#527):
 *
 * - A remembered `user_id` wins, but only when the names agree; a mismatch
 *   goes to review naming who the id actually belongs to.
 * - Otherwise, normalized name plus exactly one candidate matching on email,
 *   birth date, or site is a confident match. Zero candidates leaves the
 *   entry unmatched (not a review — it just isn't anyone yet). More than one
 *   candidate is a review.
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
): { matches: MatchResult[]; reviews: ReviewResult[] } {
  const reviews: ReviewResult[] = [];
  const tentativeByPerson = new Map<string, Array<{ entryId: string; identityKey: string; matchedBy: "IDENTITY" | "AUTO" }>>();
  const pushTentative = (entry: EntryForMatch, personId: string, matchedBy: "IDENTITY" | "AUTO") => {
    const list = tentativeByPerson.get(personId) ?? [];
    list.push({ entryId: entry.id, identityKey: entry.identityKey, matchedBy });
    tentativeByPerson.set(personId, list);
  };

  for (const entry of entries) {
    if (!entry.normalizedName) continue; // Not normalized yet; the next refresh fills it in first.
    const identity = identityByKey.get(entry.identityKey);
    if (identity) {
      if (matchableName(identity.name) !== entry.normalizedName) {
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
    const pool = (index.byName.get(entry.normalizedName) ?? []).filter((candidate) => !unavailable.has(candidate.personId));
    const candidates = candidatesForEntry(entry, pool);
    if (candidates.length === 0) continue; // Stays on the list, unmatched — not a review.
    if (candidates.length > 1) {
      reviews.push({
        entryId: entry.id,
        reason: "More than one person matches this row's name and identifying details. Nothing was guessed; match it by hand.",
        candidatePersonIds: candidates.map((candidate) => candidate.personId),
      });
      continue;
    }
    pushTentative(entry, candidates[0]!.personId, "AUTO");
  }

  const matches: MatchResult[] = [];
  for (const [personId, list] of tentativeByPerson) {
    if (list.length === 1) {
      matches.push({ entryId: list[0]!.entryId, identityKey: list[0]!.identityKey, personId, matchedBy: list[0]!.matchedBy });
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
  return { matches, reviews };
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

async function saveMatchResults(tx: PrismaLike, matches: MatchResult[], reviews: ReviewResult[], now: Date) {
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
  await rememberUserIdIdentities(tx, matches, now);
}

/** Every entry in a fresh upload, matched once, in one bounded pass (#527). */
async function runFullMatchPass(
  tx: PrismaLike,
  uploadId: string,
  now: Date,
  kept: { entryIds: Set<string>; personIds: Set<string> },
) {
  const entries = (await tx.backgroundCheckEntry.findMany({ where: { uploadId }, select: entryForMatchSelect }))
    .filter((entry) => !kept.entryIds.has(entry.id));
  if (entries.length === 0) return;
  const [index, identityByKey] = await Promise.all([
    buildCandidateIndex(tx, now),
    identitiesByKeys(tx, [...new Set(entries.map((entry) => entry.identityKey))]),
  ]);
  const { matches, reviews } = matchEntries(entries, index, identityByKey, kept.personIds);
  await saveMatchResults(tx, matches, reviews, now);
}

/**
 * Recomputes every derived match for the entries and people in the given
 * name groups (#527). Only `AUTO`/`IDENTITY` matches are cleared and
 * recomputed (B1): a `MANUAL` or `MIGRATED` match stays exactly as it is,
 * and its entry and person sit this pass out.
 */
async function recomputeNameGroups(tx: PrismaLike, uploadId: string, names: string[], now: Date) {
  const groupNames = [...new Set(names.filter(Boolean))];
  if (groupNames.length === 0) return;
  const [entries, personIds] = await Promise.all([
    tx.backgroundCheckEntry.findMany({
      where: { uploadId, normalizedName: { in: groupNames } },
      select: {
        ...entryForMatchSelect,
        match: { select: { personId: true, matchedBy: true } },
        review: { select: { dismissedAt: true, candidatePersonIds: true } },
      },
    }),
    personIdsNamed(tx, groupNames),
  ]);
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
  const derivedEntryIds = entries.filter((entry) => entry.match && !LOCKED_SOURCES.has(entry.match.matchedBy)).map((entry) => entry.id);
  if (derivedEntryIds.length > 0) {
    await tx.backgroundCheckMatch.deleteMany({ where: { entryId: { in: derivedEntryIds }, matchedBy: { in: [...DERIVED_SOURCES] } } });
  }
  const reopenedEntryIds = entries.filter((entry) => !heldOpenReview(entry)).map((entry) => entry.id);
  if (reopenedEntryIds.length > 0) await tx.backgroundCheckReview.deleteMany({ where: { entryId: { in: reopenedEntryIds }, dismissedAt: null } });

  const toMatch = entries.filter((entry) => (
    !(entry.match && LOCKED_SOURCES.has(entry.match.matchedBy)) && !dismissed(entry) && !heldOpenReview(entry)
  ));
  if (toMatch.length === 0) return;
  const [index, identityByKey, stillMatched] = await Promise.all([
    buildCandidateIndex(tx, now, { personIds }),
    identitiesByKeys(tx, [...new Set(toMatch.map((entry) => entry.identityKey))]),
    personIds.length > 0
      ? tx.backgroundCheckMatch.findMany({ where: { personId: { in: personIds } }, select: { personId: true } })
      : Promise.resolve([] as Array<{ personId: string }>),
  ]);
  const unavailable = new Set(stillMatched.map((match) => match.personId));
  // A remembered id can point at someone outside the name group only when
  // the names disagree (a review, never a match), so this covers everyone.
  const result = matchEntries(toMatch, index, identityByKey, unavailable);
  const matches = result.matches.filter((match) => !held.has(match.personId));
  const reviews = [
    ...result.reviews,
    ...result.matches.filter((match) => held.has(match.personId)).map((match) => ({
      entryId: match.entryId,
      reason: "Staff dismissed another row that matched this person. Nothing was guessed; match this one by hand, or dismiss it too.",
      candidatePersonIds: [match.personId],
    })),
  ];
  await saveMatchResults(tx, matches, reviews, now);
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
      logInfo("Background check match refresh skipped while a list upload is in progress", { people: ids.length });
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

async function requireListLock(tx: PrismaLike) {
  if (!(await tryListLock(tx))) {
    throw new BackgroundCheckOperationError("UPLOAD_IN_PROGRESS", "A background-check list upload is in progress. Try again in a moment.");
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
    await runFullMatchPass(tx, upload.id, now, kept);
    await writeAuditLog({
      actorUserId,
      action: "BACKGROUND_CHECK_LIST_UPLOADED",
      entityType: "BackgroundCheckUpload",
      entityId: upload.id,
      summary: `Uploaded a background-check list of ${deduped.length} row${deduped.length === 1 ? "" : "s"} (${format === "ROSTER" ? "roster" : "Sterling"} format): ${counts.added} added, ${counts.changed} changed, ${counts.dropped} dropped.`,
      metadata: { format, rowCount: deduped.length, added: counts.added, changed: counts.changed, dropped: counts.dropped, manualMatchesKept: kept.entryIds.size },
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
      if (!candidateIds.includes(decision.personId)) {
        throw new BackgroundCheckOperationError("NOT_A_CANDIDATE", "That person isn't one of this row's candidates.");
      }
      if (!(await tx.person.findUnique({ where: { id: decision.personId }, select: { id: true } }))) {
        throw new BackgroundCheckOperationError("NOT_A_CANDIDATE", "That person is no longer on file.");
      }
      if (isRememberedIdentityKey(review.entry.identityKey)) {
        const now = new Date();
        await tx.externalIdentity.deleteMany({
          where: { provider: ROSTER_IMPORT_PROVIDER, providerScope: "", personId: decision.personId, NOT: { externalId: review.entry.identityKey } },
        });
        await tx.externalIdentity.upsert({
          where: { provider_providerScope_externalId: { provider: ROSTER_IMPORT_PROVIDER, providerScope: "", externalId: review.entry.identityKey } },
          create: { provider: ROSTER_IMPORT_PROVIDER, providerScope: "", externalId: review.entry.identityKey, personId: decision.personId, lastVerifiedAt: now },
          update: { personId: decision.personId, lastVerifiedAt: now },
        });
      }
      await tx.backgroundCheckMatch.deleteMany({ where: { OR: [{ personId: decision.personId }, { entryId: review.entryId }] } });
      await tx.backgroundCheckMatch.create({ data: { personId: decision.personId, entryId: review.entryId, matchedBy: "MANUAL" } });
      await tx.backgroundCheckReview.deleteMany({ where: { entryId: review.entryId } });
    } else {
      await tx.backgroundCheckReview.update({ where: { id: review.id }, data: { dismissedAt: new Date() } });
    }
    await writeAuditLog({
      actorUserId,
      action: decision.type === "match" ? "BACKGROUND_CHECK_REVIEW_MATCHED" : "BACKGROUND_CHECK_REVIEW_DISMISSED",
      entityType: "BackgroundCheckReview",
      entityId: review.id,
      summary: decision.type === "match" ? "Staff matched a background-check row to a person by hand." : "Staff dismissed a background-check review; none of the candidates was right.",
      metadata: { entryId: review.entryId },
    }, tx);
  }).catch((error: unknown) => {
    // The entry or person vanished mid-way (a foreign key or missing row): a 404, not a 500.
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "P2003" || code === "P2025") throw notFound();
    if (code === "P2002") throw listChanged();
    throw error;
  });
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
      summary: "Staff undid a background-check match made by hand.",
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
    logError("Background check match refresh after undo failed", error);
  }
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

type StoredCheck = { expiresOn: string | null; complianceStatus?: BackgroundComplianceStatus | null; issuesNote?: string | null };

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
      id: true, uploadId: true, normalizedName: true, email: true, sealedBirthDate: true, site: true,
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

  const entriesByPerson = new Map<string, Array<(typeof entries)[number]>>();
  for (const entry of entries) {
    const candidates = candidatesForEntry(entry, byName.get(entry.normalizedName!) ?? []);
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

/** Counts for the system administrator's page. Sterling checks go by date; roster checks by their mark. */
export async function backgroundCheckSummary(today = calendarDateInEventTimeZone(new Date(), "America/Chicago")) {
  const soon = new Date(`${today}T12:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + 60);
  const soonDate = soon.toISOString().slice(0, 10);
  const prisma = getPrisma();
  const latestUploadForCounts = await latestUpload(prisma);
  const [currentByDate, currentByMark, soonByDate, soonByMark, expired, notCompliant, latestMatch, reviewCount, unmatchedCount, youthEvents] = await Promise.all([
    prisma.backgroundCheckMatch.count({ where: { entry: { complianceStatus: null, expiresOn: { gte: today } } } }),
    prisma.backgroundCheckMatch.count({ where: { entry: { complianceStatus: { in: ["CLEAR", "FLAGGED"] } } } }),
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
  /** The list's issues column exactly as written (#544). Staff and event managers only, like the whole flag list. */
  issuesNote: string | null;
};

/**
 * Every adult registered for a youth or children's event who has no current
 * check through the event's last day. Null when the event doesn't check.
 * Staff and event managers only; never shown to clubs.
 */
export async function listEventBackgroundFlags(eventId: string, options: { organizationId?: string } = {}) {
  const prisma = getPrisma();
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { checksAdultBackgrounds: true, startsAt: true, endsAt: true, timezone: true },
  });
  if (!event?.checksAdultBackgrounds) return null;
  const eventDate = calendarDateInEventTimeZone(event.startsAt, event.timezone);
  const lastDay = calendarDateInEventTimeZone(event.endsAt, event.timezone);
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
    const state = backgroundCheckState(check, lastDay);
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
      issuesNote: check?.issuesNote?.trim() || null,
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
 * (the driver verification queue, say). Keyed by person id.
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
 * is staff only, and a club director never receives it, not even a blank one
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
  const statuses: Record<string, { state: ClubComplianceState; note: string | null }> = {};
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
    statuses[member.id] = { state, note: options.includeNotes ? check?.issuesNote ?? null : null };
  }
  return { statuses, notInCompliance, expiringSoon, missing };
}

/**
 * Just the reminder counts behind club home "What's next" and the club
 * overview (#479) — never the per-member statuses, so a caller that isn't
 * allowed to see the roster's background-check column (an Area Coordinator)
 * can still show the same counts without any name or note attached.
 */
export async function clubComplianceReminderCounts(organizationId: string, clubYear: string) {
  const { notInCompliance, expiringSoon, missing } = await clubRosterComplianceStatuses(organizationId, clubYear, { includeNotes: false });
  return { notInCompliance, expiringSoon, missing };
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
