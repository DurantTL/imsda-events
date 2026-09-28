import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { openBirthDate, sealBirthDate } from "@/modules/club-rosters/birth-dates";
import { ageOn, clubYearFor } from "@/modules/club-rosters/domain";
import type { ClubCapabilities } from "@/modules/organizations/director-grants-domain";
import { activeRegistrationStatuses, calendarDateInEventTimeZone } from "@/modules/events/lifecycle";
import {
  ageFromAnswer,
  attendeeIsAdult,
  backgroundCheckState,
  clubComplianceState,
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
 * entry happens at lookup — see `refreshBackgroundCheckMatchForPerson` and
 * `runFullMatchPass` — never re-run on every render; renders read the
 * derived `BackgroundCheckMatch` cache, a single indexed join per person.
 * Flags only: registration and check-in never wait on a check.
 */

const ROSTER_IMPORT_PROVIDER = "ROSTER_IMPORT";
type PrismaLike = PrismaClient | Prisma.TransactionClient;

function openEntryBirthDate(sealed: string | null) {
  if (!sealed) return null;
  try {
    return openBirthDate(sealed);
  } catch {
    return null;
  }
}

// --- Upload: preview (counts) and apply (replace the list) ---

export type BackgroundCheckUploadCounts = { added: number; changed: number; dropped: number; total: number };

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

/** The most recent upload's entries — "the list" as it stands today. */
async function currentEntries(prisma: PrismaLike): Promise<StoredEntryFields[]> {
  const latest = await prisma.backgroundCheckUpload.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true } });
  if (!latest) return [];
  return prisma.backgroundCheckEntry.findMany({
    where: { uploadId: latest.id },
    select: {
      identityKey: true, firstName: true, lastName: true, email: true, sealedBirthDate: true,
      site: true, sourceUserId: true, complianceStatus: true, checkedOn: true, expiresOn: true, issuesNote: true,
    },
  });
}

/** The later row wins when an upload's own rows share an identity key. */
function dedupeByIdentityKey(rows: BackgroundCheckListRow[]): BackgroundCheckListRow[] {
  const byKey = new Map<string, BackgroundCheckListRow>();
  for (const row of rows) byKey.set(row.identityKey, row);
  return [...byKey.values()].sort((a, b) => a.line - b.line);
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
 * What an upload would do to the list (#527): the counts staff confirm
 * before saving. Compares by `identityKey`, so a row recognized as the same
 * person as before (by `user_id`, email, birth date, or site+name) counts as
 * "changed" only when its stored fields actually differ, never "added".
 */
export async function planBackgroundCheckUpload(rows: BackgroundCheckListRow[]): Promise<BackgroundCheckUploadCounts> {
  const deduped = dedupeByIdentityKey(rows);
  const existing = await currentEntries(getPrisma());
  const existingByKey = new Map(existing.map((entry) => [entry.identityKey, entry]));
  const seenKeys = new Set<string>();
  let added = 0;
  let changed = 0;
  for (const row of deduped) {
    seenKeys.add(row.identityKey);
    const prior = existingByKey.get(row.identityKey);
    if (!prior) added += 1;
    else if (entryChanged(prior, row)) changed += 1;
  }
  const dropped = existing.filter((entry) => !seenKeys.has(entry.identityKey)).length;
  return { added, changed, dropped, total: deduped.length };
}

// --- Matching engine: candidates, ambiguity, and the derived cache ---

type NameCandidate = { personId: string; name: string; emails: Set<string>; birthDates: Set<string>; siteNames: Set<string> };
type NameIndex = { byName: Map<string, NameCandidate[]> };

/** Registered adults are matched only for events upcoming or ended within this many months. */
const REGISTRATION_LOOKBACK_MONTHS = 12;
const BIRTH_ANSWER_KEYS = ["date_of_birth", "birth_date", "birthdate", "dob"];
const AGE_ANSWER_KEYS = ["attendee_age", "age"];

const clubSelect = { select: { name: true, parentOrganization: { select: { name: true } } } } as const;
const personEmailSelect = {
  normalizedEmail: true,
  attendeeAccountLinks: { select: { account: { select: { email: true } } } },
} as const;

function personEmails(person: { normalizedEmail: string | null; attendeeAccountLinks: Array<{ account: { email: string } }> }) {
  const emails = new Set<string>();
  if (person.normalizedEmail) emails.add(person.normalizedEmail.toLowerCase());
  for (const link of person.attendeeAccountLinks) emails.add(link.account.email.toLowerCase());
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

function attendeeAge(
  snapshot: { ageOnEventDate?: unknown },
  responses: Record<string, unknown>,
  onDate: string,
): number | null {
  if (typeof snapshot.ageOnEventDate === "number") return snapshot.ageOnEventDate;
  const ageKey = AGE_ANSWER_KEYS.find((key) => responses[key] !== undefined && responses[key] !== "");
  if (ageKey) return ageFromAnswer(responses[ageKey]);
  const birthKey = BIRTH_ANSWER_KEYS.find((key) => typeof responses[key] === "string" && responses[key]);
  const birthDate = birthKey ? normalizeCheckDate(String(responses[birthKey])) : null;
  return birthDate ? ageOn(birthDate, onDate) : null;
}

/**
 * Every adult on a current club roster, or registered for an event upcoming
 * or ended in the last 12 months, with their known emails, birth dates, and
 * club/church names — the candidate pool matching draws from. Built once for
 * a full pass over the whole list, or scoped to one name pair for a single
 * person's targeted recompute, so neither path scans more than it needs.
 */
async function buildCandidateIndex(
  tx: PrismaLike,
  now: Date,
  onlyName?: { firstName: string; lastName: string },
): Promise<NameIndex> {
  const clubYear = clubYearFor(now);
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - REGISTRATION_LOOKBACK_MONTHS);
  const today = calendarDateInEventTimeZone(now, "America/Chicago");
  const nameFilter = onlyName
    ? { person: { firstName: { equals: onlyName.firstName, mode: "insensitive" as const }, lastName: { equals: onlyName.lastName, mode: "insensitive" as const } } }
    : {};

  const [rosterMembers, attendees] = await Promise.all([
    tx.clubRosterMember.findMany({
      where: { clubYear, status: "ACTIVE", attendeeType: { in: ["ADULT", "STAFF"] }, personId: { not: null }, ...nameFilter },
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
        ...(onlyName ? { person: nameFilter.person } : {}),
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
    const birthDates = new Set<string>();
    if (member.sealedBirthDate) {
      try {
        birthDates.add(openBirthDate(member.sealedBirthDate));
      } catch {
        // An unreadable sealed date just can't be used to match.
      }
    }
    rememberCandidate(byPerson, member.personId, member.person.firstName, member.person.lastName, {
      emails: personEmails(member.person),
      birthDates,
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
    const club = attendee.registration.clubRegistration?.organization;
    rememberCandidate(byPerson, attendee.personId, attendee.person.firstName, attendee.person.lastName, {
      emails,
      sites: [club?.name, club?.parentOrganization?.name],
    });
  }

  const byName = new Map<string, NameCandidate[]>();
  for (const candidate of byPerson.values()) {
    const key = matchableName(candidate.name);
    const list = byName.get(key) ?? [];
    list.push(candidate);
    byName.set(key, list);
  }
  return { byName };
}

type EntryForMatch = { id: string; identityKey: string; normalizedName: string; email: string | null; sealedBirthDate: string | null; site: string | null };
type MatchResult = { entryId: string; personId: string; matchedBy: "IDENTITY" | "AUTO" };
type ReviewResult = { entryId: string; reason: string; candidatePersonIds: string[] };

function candidatesForEntry(entry: EntryForMatch, pool: NameCandidate[]): NameCandidate[] {
  const birthDate = openEntryBirthDate(entry.sealedBirthDate);
  return pool.filter((candidate) => (
    (entry.email && candidate.emails.has(entry.email))
    || (birthDate && candidate.birthDates.has(birthDate))
    || (entry.site && matchesSite(entry.site, candidate.siteNames))
  ));
}

/**
 * Matches a set of entries (all sharing the candidate pool in `index`)
 * against people, the same rules every time (#527):
 *
 * - A remembered `user_id` wins, but only when the names agree; a mismatch
 *   goes to review naming who the id actually belongs to.
 * - Otherwise, normalized name plus exactly one candidate matching on email,
 *   birth date, or site is a confident match. Zero candidates leaves the
 *   entry unmatched (not a review — it just isn't anyone yet). More than one
 *   candidate is a review.
 * - A person matched by more than one entry is also a review, for every
 *   entry that matched them — never guessed which one is right.
 */
function matchEntries(
  entries: EntryForMatch[],
  index: NameIndex,
  identityByKey: Map<string, { personId: string; name: string }>,
): { matches: MatchResult[]; reviews: ReviewResult[] } {
  const reviews: ReviewResult[] = [];
  const tentativeByPerson = new Map<string, Array<{ entryId: string; matchedBy: "IDENTITY" | "AUTO" }>>();
  const pushTentative = (entryId: string, personId: string, matchedBy: "IDENTITY" | "AUTO") => {
    const list = tentativeByPerson.get(personId) ?? [];
    list.push({ entryId, matchedBy });
    tentativeByPerson.set(personId, list);
  };

  for (const entry of entries) {
    const identity = identityByKey.get(entry.identityKey);
    if (identity) {
      if (matchableName(identity.name) === entry.normalizedName) {
        pushTentative(entry.id, identity.personId, "IDENTITY");
      } else {
        reviews.push({
          entryId: entry.id,
          reason: `The remembered match for this row belongs to ${identity.name}, but this row's name is different. Check it and match by hand.`,
          candidatePersonIds: [identity.personId],
        });
      }
      continue;
    }
    const pool = index.byName.get(entry.normalizedName) ?? [];
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
    pushTentative(entry.id, candidates[0]!.personId, "AUTO");
  }

  const matches: MatchResult[] = [];
  for (const [personId, list] of tentativeByPerson) {
    if (list.length === 1) {
      matches.push({ entryId: list[0]!.entryId, personId, matchedBy: list[0]!.matchedBy });
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
  if (identityKeys.length === 0) return new Map<string, { personId: string; name: string }>();
  const identities = await tx.externalIdentity.findMany({
    where: { provider: "ROSTER_IMPORT", providerScope: "", externalId: { in: identityKeys } },
    select: { externalId: true, personId: true, person: { select: { firstName: true, lastName: true } } },
  });
  return new Map(
    identities
      .filter((identity): identity is typeof identity & { personId: string; person: NonNullable<typeof identity.person> } => Boolean(identity.personId && identity.person))
      .map((identity) => [identity.externalId, { personId: identity.personId, name: `${identity.person.firstName} ${identity.person.lastName}`.trim() }]),
  );
}

async function saveMatchResults(tx: PrismaLike, matches: MatchResult[], reviews: ReviewResult[]) {
  if (matches.length > 0) {
    await tx.backgroundCheckMatch.createMany({
      data: matches.map((match) => ({ personId: match.personId, entryId: match.entryId, matchedBy: match.matchedBy })),
    });
  }
  if (reviews.length > 0) {
    await tx.backgroundCheckReview.createMany({
      data: reviews.map((review) => ({ entryId: review.entryId, reason: review.reason, candidatePersonIds: review.candidatePersonIds })),
    });
  }
}

/** Every entry in a fresh upload, matched once, in one bounded pass (#527). */
async function runFullMatchPass(tx: PrismaLike, uploadId: string, now: Date) {
  const entries = await tx.backgroundCheckEntry.findMany({
    where: { uploadId },
    select: { id: true, identityKey: true, normalizedName: true, email: true, sealedBirthDate: true, site: true },
  });
  if (entries.length === 0) return;
  const [index, identityByKey] = await Promise.all([
    buildCandidateIndex(tx, now),
    identitiesByKeys(tx, [...new Set(entries.map((entry) => entry.identityKey))]),
  ]);
  const { matches, reviews } = matchEntries(entries, index, identityByKey);
  await saveMatchResults(tx, matches, reviews);
}

/**
 * Re-matches just the entries and candidates that share one person's current
 * name (#527): called when a person or roster member is added or edited, so
 * someone already on the list is matched without a re-upload, without
 * rescanning the whole list or the whole roster. Clears any stale match or
 * review this person or their name's entries held before recomputing.
 */
export async function refreshBackgroundCheckMatchForPerson(personId: string, now = new Date()) {
  const prisma = getPrisma();
  const person = await prisma.person.findUnique({ where: { id: personId }, select: { firstName: true, lastName: true } });
  if (!person) return;
  const normalizedName = matchableName(`${person.firstName} ${person.lastName}`);
  await prisma.$transaction(async (tx) => {
    const entries = await tx.backgroundCheckEntry.findMany({
      where: { normalizedName },
      select: { id: true, identityKey: true, normalizedName: true, email: true, sealedBirthDate: true, site: true },
    });
    const index = await buildCandidateIndex(tx, now, { firstName: person.firstName, lastName: person.lastName });
    const candidates = index.byName.get(normalizedName) ?? [];
    const personIds = new Set([personId, ...candidates.map((candidate) => candidate.personId)]);
    const entryIds = entries.map((entry) => entry.id);

    await tx.backgroundCheckMatch.deleteMany({ where: { OR: [{ entryId: { in: entryIds } }, { personId: { in: [...personIds] } }] } });
    await tx.backgroundCheckReview.deleteMany({ where: { entryId: { in: entryIds } } });

    if (entries.length === 0) return;
    const identityByKey = await identitiesByKeys(tx, [...new Set(entries.map((entry) => entry.identityKey))]);
    const { matches, reviews } = matchEntries(entries, index, identityByKey);
    await saveMatchResults(tx, matches, reviews);
  }, { timeout: 30_000, maxWait: 10_000 });
}

/**
 * Records the upload: replaces the list wholesale and re-matches it (#527).
 * Audits only counts — never names or dates.
 */
export async function applyBackgroundCheckUpload(
  rows: BackgroundCheckListRow[],
  format: "ROSTER" | "STERLING",
  actorUserId: string,
  now = new Date(),
): Promise<BackgroundCheckUploadCounts> {
  const deduped = dedupeByIdentityKey(rows);
  const preview = await planBackgroundCheckUpload(deduped);
  await getPrisma().$transaction(async (tx) => {
    const previousLatest = await tx.backgroundCheckUpload.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true } });
    const upload = await tx.backgroundCheckUpload.create({
      data: { format, rowCount: deduped.length, added: preview.added, changed: preview.changed, dropped: preview.dropped, uploadedByUserId: actorUserId },
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
    if (previousLatest) await tx.backgroundCheckEntry.deleteMany({ where: { uploadId: previousLatest.id } });
    await runFullMatchPass(tx, upload.id, now);
    await writeAuditLog({
      actorUserId,
      action: "BACKGROUND_CHECK_LIST_UPLOADED",
      entityType: "BackgroundCheckUpload",
      entityId: upload.id,
      summary: `Uploaded a background-check list of ${deduped.length} row${deduped.length === 1 ? "" : "s"} (${format === "ROSTER" ? "roster" : "Sterling"} format): ${preview.added} added, ${preview.changed} changed, ${preview.dropped} dropped.`,
      metadata: { format, rowCount: deduped.length, added: preview.added, changed: preview.changed, dropped: preview.dropped },
    }, tx);
  }, { timeout: 120_000, maxWait: 15_000 });
  return preview;
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
 * (#527). A match is remembered (`ExternalIdentity`) so it holds on the next
 * upload; a dismissal is not remembered and may resurface if the same
 * ambiguity recomputes later — nothing is guessed either way.
 */
export async function resolveBackgroundCheckReview(
  reviewId: string,
  decision: { type: "match"; personId: string } | { type: "dismiss" },
  actorUserId: string,
) {
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    const review = await tx.backgroundCheckReview.findUnique({
      where: { id: reviewId },
      select: { id: true, entryId: true, candidatePersonIds: true, entry: { select: { identityKey: true } } },
    });
    if (!review) return;
    if (decision.type === "match") {
      const candidateIds = review.candidatePersonIds as string[];
      if (!candidateIds.includes(decision.personId)) throw new Error("That person isn't one of this row's candidates.");
      const now = new Date();
      await tx.externalIdentity.deleteMany({
        where: { provider: "ROSTER_IMPORT", providerScope: "", personId: decision.personId, NOT: { externalId: review.entry.identityKey } },
      });
      await tx.externalIdentity.upsert({
        where: { provider_providerScope_externalId: { provider: "ROSTER_IMPORT", providerScope: "", externalId: review.entry.identityKey } },
        create: { provider: "ROSTER_IMPORT", providerScope: "", externalId: review.entry.identityKey, personId: decision.personId, lastVerifiedAt: now },
        update: { personId: decision.personId, lastVerifiedAt: now },
      });
      await tx.backgroundCheckMatch.deleteMany({ where: { OR: [{ personId: decision.personId }, { entryId: review.entryId }] } });
      await tx.backgroundCheckMatch.create({ data: { personId: decision.personId, entryId: review.entryId, matchedBy: "MANUAL" } });
    }
    await tx.backgroundCheckReview.deleteMany({ where: { entryId: review.entryId } });
    await writeAuditLog({
      actorUserId,
      action: decision.type === "match" ? "BACKGROUND_CHECK_REVIEW_MATCHED" : "BACKGROUND_CHECK_REVIEW_DISMISSED",
      entityType: "BackgroundCheckReview",
      entityId: review.id,
      summary: decision.type === "match" ? "Staff matched a background-check row to a person by hand." : "Staff dismissed a background-check review; none of the candidates was right.",
      metadata: { entryId: review.entryId },
    }, tx);
  });
}

/** List entries under the current upload that match no one yet — visible to staff, not guessed. */
export async function listUnmatchedBackgroundCheckEntries() {
  const prisma = getPrisma();
  const latest = await prisma.backgroundCheckUpload.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true } });
  if (!latest) return [];
  return prisma.backgroundCheckEntry.findMany({
    where: { uploadId: latest.id, match: null, reviews: { none: {} } },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    select: { id: true, firstName: true, lastName: true, site: true, complianceStatus: true, checkedOn: true, expiresOn: true },
  });
}

// --- Read path: everywhere a person's compliance is looked up ---

type StoredCheck = { expiresOn: string | null; complianceStatus?: BackgroundComplianceStatus | null };

/** Counts for the system administrator's page. Sterling checks go by date; roster checks by their mark. */
export async function backgroundCheckSummary(today = calendarDateInEventTimeZone(new Date(), "America/Chicago")) {
  const soon = new Date(`${today}T12:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + 60);
  const soonDate = soon.toISOString().slice(0, 10);
  const prisma = getPrisma();
  const latestUploadForCounts = await prisma.backgroundCheckUpload.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true, createdAt: true } });
  const [currentByDate, currentByMark, soonByDate, soonByMark, expired, notCompliant, latestMatch, reviewCount, unmatchedCount, youthEvents] = await Promise.all([
    prisma.backgroundCheckMatch.count({ where: { entry: { complianceStatus: null, expiresOn: { gte: today } } } }),
    prisma.backgroundCheckMatch.count({ where: { entry: { complianceStatus: { in: ["CLEAR", "FLAGGED"] } } } }),
    prisma.backgroundCheckMatch.count({ where: { entry: { complianceStatus: null, expiresOn: { gte: today, lte: soonDate } } } }),
    prisma.backgroundCheckMatch.count({ where: { entry: { complianceStatus: "FLAGGED" } } }),
    prisma.backgroundCheckMatch.count({ where: { entry: { complianceStatus: null, expiresOn: { lt: today } } } }),
    prisma.backgroundCheckMatch.count({ where: { entry: { complianceStatus: "NOT_COMPLIANT" } } }),
    prisma.backgroundCheckMatch.findFirst({ orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
    prisma.backgroundCheckReview.count(),
    latestUploadForCounts ? prisma.backgroundCheckEntry.count({ where: { uploadId: latestUploadForCounts.id, match: null, reviews: { none: {} } } }) : Promise.resolve(0),
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
      person: { select: { firstName: true, lastName: true, backgroundCheckMatch: { select: { entry: { select: { expiresOn: true, complianceStatus: true } } } } } },
      registration: {
        select: {
          id: true,
          confirmationCode: true,
          clubRegistration: { select: { organizationId: true, organization: { select: { name: true } } } },
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

  let adults = 0;
  const people: BackgroundFlag[] = [];
  for (const attendee of attendees) {
    const snapshot = (attendee.profileSnapshot ?? {}) as { ageOnEventDate?: unknown; clubRosterMemberId?: unknown; firstName?: unknown; lastName?: unknown };
    const responses = (attendee.formResponses ?? {}) as Record<string, unknown>;
    const age = attendeeAge(snapshot, responses, eventDate);
    const rosterAttendeeType = typeof snapshot.clubRosterMemberId === "string" ? rosterTypes.get(snapshot.clubRosterMemberId) ?? null : null;
    if (!attendeeIsAdult({ ageOnEventDate: age, rosterAttendeeType, attendeeType: attendee.attendeeType })) continue;
    adults += 1;
    const check: StoredCheck | null = attendee.person.backgroundCheckMatch?.entry ?? null;
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
    });
  }
  return { adults, people, lastDay };
}

/** Just the attendee IDs to flag, for rosters and check-in. Empty when the event doesn't check. */
export async function backgroundFlaggedAttendeeIds(eventId: string) {
  const flags = await listEventBackgroundFlags(eventId);
  return new Set(flags?.people.map((person) => person.attendeeId) ?? []);
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
  const members = await getPrisma().clubRosterMember.findMany({
    where: { organizationId, clubYear, status: "ACTIVE", attendeeType: { in: ["ADULT", "STAFF"] } },
    select: {
      id: true,
      person: { select: { backgroundCheckMatch: { select: { entry: { select: { complianceStatus: true, expiresOn: true, issuesNote: true } } } } } },
    },
  });
  const statuses: Record<string, { state: ClubComplianceState; note: string | null }> = {};
  let notInCompliance = 0;
  let expiringSoon = 0;
  let missing = 0;
  for (const member of members) {
    const check: StoredCheck | null = member.person?.backgroundCheckMatch?.entry ?? null;
    const state = clubComplianceState(check, today);
    if (state === "NOT_COMPLIANT") notInCompliance += 1;
    if (state === "FLAGGED") expiringSoon += 1;
    if (state === "NO_RECORD") missing += 1;
    statuses[member.id] = { state, note: options.includeNotes ? member.person?.backgroundCheckMatch?.entry.issuesNote ?? null : null };
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
