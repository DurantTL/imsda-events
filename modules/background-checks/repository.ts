import "server-only";

import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { openBirthDate } from "@/modules/club-rosters/birth-dates";
import { ageOn, clubYearFor } from "@/modules/club-rosters/domain";
import type { ClubCapabilities } from "@/modules/organizations/director-grants-domain";
import { activeRegistrationStatuses, calendarDateInEventTimeZone } from "@/modules/events/lifecycle";
import {
  ageFromAnswer,
  attendeeIsAdult,
  backgroundCheckState,
  clubComplianceState,
  isClearStatus,
  matchableName,
  matchesSite,
  normalizeCheckDate,
  type BackgroundCheckState,
  type ClubComplianceState,
  type BackgroundComplianceStatus,
  type RosterBackgroundCsvRow,
  type SterlingCsvRow,
} from "@/modules/background-checks/domain";

/**
 * Background checks (#388): matching the Sterling Volunteers CSV to people,
 * recording the dates, and flagging adults at youth or children's events who
 * have no current check. Flags only: registration and check-in never wait on it.
 */

export type SterlingImportStep = {
  line: number;
  name: string;
  action: "ADD" | "UPDATE" | "SKIP";
  message: string;
  personId?: string;
  checkedOn?: string | null;
  expiresOn?: string;
};

type Candidate = { id: string; emails: Set<string>; birthDates: Set<string> };

async function candidatesNamed(firstName: string, lastName: string): Promise<Candidate[]> {
  const people = await getPrisma().person.findMany({
    where: {
      firstName: { equals: firstName, mode: "insensitive" },
      lastName: { equals: lastName, mode: "insensitive" },
    },
    take: 25,
    select: {
      id: true,
      normalizedEmail: true,
      attendeeAccountLinks: { select: { account: { select: { email: true } } } },
      registrationEvents: { take: 20, orderBy: { createdAt: "desc" }, select: { profileSnapshot: true } },
      clubRosterMemberships: { where: { sealedBirthDate: { not: null } }, select: { sealedBirthDate: true } },
    },
  });
  return people.map((person) => {
    const emails = new Set<string>();
    if (person.normalizedEmail) emails.add(person.normalizedEmail.toLowerCase());
    for (const link of person.attendeeAccountLinks) emails.add(link.account.email.toLowerCase());
    for (const { profileSnapshot } of person.registrationEvents) {
      const email = (profileSnapshot as { email?: unknown } | null)?.email;
      if (typeof email === "string" && email) emails.add(email.trim().toLowerCase());
    }
    const birthDates = new Set<string>();
    for (const membership of person.clubRosterMemberships) {
      try {
        birthDates.add(openBirthDate(membership.sealedBirthDate!));
      } catch {
        // An unreadable sealed date just can't be used to match.
      }
    }
    return { id: person.id, emails, birthDates };
  });
}

/**
 * What an upload would do, row by row. A person is matched by name plus email
 * or birth date; a row matching nobody, or more than one person, is reported
 * and skipped. Messages never repeat anything already on file.
 */
export async function planSterlingImport(rows: SterlingCsvRow[]): Promise<SterlingImportStep[]> {
  const steps: SterlingImportStep[] = [];
  const bestByPerson = new Map<string, SterlingImportStep>();
  for (const row of rows) {
    const name = `${row.firstName} ${row.lastName}`.trim() || "(no name)";
    const skip = (message: string) => steps.push({ line: row.line, name, action: "SKIP", message });
    if (row.problems.length > 0) {
      skip(row.problems.join(" "));
      continue;
    }
    if (!isClearStatus(row.status)) {
      skip(`Status is "${row.status}", not a clear check, so nothing was recorded. Review this person in Sterling.`);
      continue;
    }
    const firstName = matchableName(row.firstName);
    const lastName = matchableName(row.lastName);
    const named = (await candidatesNamed(row.firstName, row.lastName))
      .concat(firstName !== row.firstName.toLowerCase() || lastName !== row.lastName.toLowerCase() ? await candidatesNamed(firstName, lastName) : []);
    const unique = [...new Map(named.map((candidate) => [candidate.id, candidate])).values()];
    const matches = unique.filter((candidate) => (
      (row.email && candidate.emails.has(row.email)) || (row.birthDate && candidate.birthDates.has(row.birthDate))
    ));
    if (matches.length === 0) {
      skip(unique.length === 0
        ? "No one by this name has registered or is on a club roster."
        : "Someone by this name is on file, but the email or birth date didn't match. Check it and add the person by hand if needed.");
      continue;
    }
    if (matches.length > 1) {
      skip("More than one person matches this row. Nothing was recorded; check these people by hand.");
      continue;
    }
    const step: SterlingImportStep = {
      line: row.line,
      name,
      action: "ADD",
      message: "",
      personId: matches[0]!.id,
      checkedOn: row.checkedOn,
      expiresOn: row.expiresOn!,
    };
    const earlier = bestByPerson.get(step.personId!);
    if (earlier) {
      if (earlier.expiresOn! >= step.expiresOn!) {
        skip(`Same person as row ${earlier.line}, which has the later expiration.`);
        continue;
      }
      earlier.action = "SKIP";
      earlier.message = `Same person as row ${step.line}, which has the later expiration.`;
      delete earlier.personId;
    }
    bestByPerson.set(step.personId!, step);
    steps.push(step);
  }

  const personIds = [...bestByPerson.keys()];
  const existing = new Map((await getPrisma().backgroundCheck.findMany({
    where: { personId: { in: personIds } },
    select: { personId: true, expiresOn: true, complianceStatus: true },
  })).map((check) => [check.personId, check]));
  for (const step of bestByPerson.values()) {
    if (step.action === "SKIP") continue;
    const record = existing.get(step.personId!);
    const onFile = record?.expiresOn ?? null;
    if (onFile && onFile >= step.expiresOn!) {
      step.action = "SKIP";
      step.message = "A check lasting at least as long is already on file.";
      delete step.personId;
    } else {
      // A roster import's row (no expiration date) is still a row on file: this replaces it.
      step.action = existing.has(step.personId!) ? "UPDATE" : "ADD";
      // The newest upload wins; say so when it replaces a roster import's mark.
      const replaces = record?.complianceStatus ? ` Replaces the roster mark: ${complianceLabels[record.complianceStatus]}.` : "";
      step.message = `Check good through ${step.expiresOn}.${replaces}`;
    }
  }
  return steps.sort((a, b) => a.line - b.line);
}

/**
 * Records the matched rows. Only the dates are kept; the file is not. The
 * newest upload wins (#427): a Sterling check replaces a roster import's
 * compliance mark and note on the same row.
 */
export async function applySterlingImport(steps: SterlingImportStep[], actorUserId: string) {
  const toSave = steps.filter((step) => step.action !== "SKIP" && step.personId && step.expiresOn);
  await getPrisma().$transaction(async (tx) => {
    for (const step of toSave) {
      const data = {
        provider: "STERLING",
        checkedOn: step.checkedOn ?? null,
        expiresOn: step.expiresOn!,
        complianceStatus: null,
        issuesNote: null,
        recordedByUserId: actorUserId,
      };
      await tx.backgroundCheck.upsert({
        where: { personId: step.personId! },
        create: { personId: step.personId!, ...data },
        update: data,
      });
    }
    await writeAuditLog({
      actorUserId,
      action: "BACKGROUND_CHECKS_IMPORTED",
      entityType: "BackgroundCheck",
      entityId: "sterling-import",
      summary: `Recorded ${toSave.length} Sterling Volunteers background check${toSave.length === 1 ? "" : "s"} from an upload.`,
      metadata: {
        added: steps.filter((step) => step.action === "ADD").length,
        updated: steps.filter((step) => step.action === "UPDATE").length,
        skipped: steps.filter((step) => step.action === "SKIP").length,
      },
    }, tx);
  }, { timeout: 60_000, maxWait: 10_000 });
  return {
    added: steps.filter((step) => step.action === "ADD").length,
    updated: steps.filter((step) => step.action === "UPDATE").length,
  };
}

// --- Roster import (#427) ---

const ROSTER_IMPORT_PROVIDER = "ROSTER_IMPORT";
/** Rows saved per transaction, so a 5,000-row confirm never holds one giant transaction open. */
export const ROSTER_IMPORT_BATCH_SIZE = 250;
/** Each batch gets longer than Prisma's 5-second default, as the staging import does. */
const ROSTER_IMPORT_TRANSACTION = { timeout: 60_000, maxWait: 10_000 };
/** Registered adults are matched only for events upcoming or ended within this many months. */
const REGISTRATION_LOOKBACK_MONTHS = 12;

/** Someone a REVIEW row might be: full name and every club or church on file, for staff to pick by hand. */
export type RosterImportCandidate = { personId: string; name: string; sites: string[] };

export type RosterImportStep = {
  line: number;
  name: string;
  action: "ADD" | "UPDATE" | "SKIP" | "REVIEW";
  message: string;
  personId?: string;
  userId?: string | null;
  compliance?: BackgroundComplianceStatus;
  /** Staff-only; shown for every row in the preview and on save, not just matched ones. */
  issuesNote?: string | null;
  /** Only on a REVIEW row: who it might be, so staff can pick by hand. Never picked automatically. */
  candidates?: RosterImportCandidate[];
};

const complianceLabels = { CLEAR: "Clear", FLAGGED: "Expiring soon", NOT_COMPLIANT: "Not in compliance" } as const;

type NameCandidate = { personId: string; name: string; siteNames: Set<string> };

type NameIndex = { byName: Map<string, NameCandidate[]>; byPerson: Map<string, NameCandidate> };

function candidateView(candidate: NameCandidate): RosterImportCandidate {
  return { personId: candidate.personId, name: candidate.name, sites: [...candidate.siteNames] };
}

/**
 * Every adult on a current club roster, or registered for an event that is
 * upcoming or ended in the last 12 months, indexed by normalized name. Built
 * once so matching 5,000 rows is a map lookup each instead of a query each.
 */
async function rosterBackgroundNameIndex(now: Date): Promise<NameIndex> {
  const prisma = getPrisma();
  const clubYear = clubYearFor(now);
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - REGISTRATION_LOOKBACK_MONTHS);
  const today = calendarDateInEventTimeZone(now, "America/Chicago");
  const clubSelect = { select: { name: true, parentOrganization: { select: { name: true } } } } as const;
  const [rosterMembers, attendees] = await Promise.all([
    prisma.clubRosterMember.findMany({
      where: { clubYear, status: "ACTIVE", attendeeType: { in: ["ADULT", "STAFF"] }, personId: { not: null } },
      select: {
        personId: true,
        person: { select: { firstName: true, lastName: true } },
        organization: clubSelect,
      },
    }),
    prisma.registrationAttendee.findMany({
      where: {
        event: { endsAt: { gte: cutoff } },
        registration: { status: { in: [...activeRegistrationStatuses] } },
      },
      select: {
        personId: true,
        attendeeType: true,
        profileSnapshot: true,
        formResponses: true,
        person: { select: { firstName: true, lastName: true } },
        registration: { select: { clubRegistration: { select: { organization: clubSelect } } } },
      },
    }),
  ]);

  const byPerson = new Map<string, NameCandidate>();
  const remember = (personId: string, firstName: string, lastName: string, sites: Array<string | null | undefined>) => {
    let entry = byPerson.get(personId);
    if (!entry) {
      entry = { personId, name: `${firstName} ${lastName}`.trim(), siteNames: new Set() };
      byPerson.set(personId, entry);
    }
    for (const site of sites) if (site) entry.siteNames.add(site);
  };

  for (const member of rosterMembers) {
    if (!member.personId || !member.person) continue;
    remember(member.personId, member.person.firstName, member.person.lastName, [
      member.organization.name,
      member.organization.parentOrganization?.name,
    ]);
  }
  for (const attendee of attendees) {
    if (!attendee.person) continue;
    const snapshot = (attendee.profileSnapshot ?? {}) as { ageOnEventDate?: unknown };
    const responses = (attendee.formResponses ?? {}) as Record<string, unknown>;
    let age = typeof snapshot.ageOnEventDate === "number" ? snapshot.ageOnEventDate : null;
    if (age === null) {
      const ageKey = AGE_ANSWER_KEYS.find((key) => responses[key] !== undefined && responses[key] !== "");
      age = ageKey ? ageFromAnswer(responses[ageKey]) : null;
    }
    if (age === null) {
      const birthKey = BIRTH_ANSWER_KEYS.find((key) => typeof responses[key] === "string" && responses[key]);
      const birthDate = birthKey ? normalizeCheckDate(String(responses[birthKey])) : null;
      if (birthDate) age = ageOn(birthDate, today);
    }
    if (!attendeeIsAdult({ ageOnEventDate: age, attendeeType: attendee.attendeeType })) continue;
    const club = attendee.registration.clubRegistration?.organization;
    remember(attendee.personId, attendee.person.firstName, attendee.person.lastName, [club?.name, club?.parentOrganization?.name]);
  }

  const byName = new Map<string, NameCandidate[]>();
  for (const candidate of byPerson.values()) {
    const key = matchableName(candidate.name);
    const list = byName.get(key) ?? [];
    list.push(candidate);
    byName.set(key, list);
  }
  return { byName, byPerson };
}

/**
 * What a roster-import upload would do, row by row (#427). Nothing is ever
 * guessed; anything uncertain is listed as "needs review" with its candidates.
 *
 * - A remembered `user_id` matches first, but only when the row's name is
 *   that person's name.
 * - Otherwise the row is matched by normalized name. When `sites` is filled
 *   in, it must be the person's club or sponsoring church, and it narrows a
 *   name shared by more than one person.
 * - A `user_id` used in the file for different people, one person matched
 *   by rows with different `user_id`s, or a person already remembered under
 *   another `user_id`, needs review.
 */
export async function planRosterBackgroundImport(rows: RosterBackgroundCsvRow[], now = new Date()): Promise<RosterImportStep[]> {
  const prisma = getPrisma();
  const steps: RosterImportStep[] = [];

  const userIds = [...new Set(rows.map((row) => row.userId).filter((id): id is string => Boolean(id)))];
  const identities = userIds.length > 0
    ? await prisma.externalIdentity.findMany({
      where: { provider: ROSTER_IMPORT_PROVIDER, providerScope: "", externalId: { in: userIds } },
      select: { externalId: true, personId: true, person: { select: { firstName: true, lastName: true } } },
    })
    : [];
  const identityByUserId = new Map(identities.map((identity) => [identity.externalId, identity]));
  const index = await rosterBackgroundNameIndex(now);

  const review = (row: RosterBackgroundCsvRow, name: string, message: string, candidates: RosterImportCandidate[]): RosterImportStep => ({
    line: row.line, name, action: "REVIEW", message, candidates, issuesNote: row.issuesNote,
  });

  // 1. Resolve each row on its own.
  const resolved: Array<RosterImportStep & { personId: string; userId: string }> = [];
  for (const row of rows) {
    const name = `${row.firstName} ${row.lastName}`.trim() || "(no name)";
    if (row.problems.length > 0) {
      steps.push({ line: row.line, name, action: "SKIP", message: row.problems.join(" "), issuesNote: row.issuesNote });
      continue;
    }
    const userId = row.userId!;
    const matched = (personId: string, message: string) => resolved.push({
      line: row.line, name, action: "ADD", message, personId, userId, compliance: row.compliance!, issuesNote: row.issuesNote,
    });

    const identity = identityByUserId.get(userId);
    if (identity?.personId && identity.person) {
      const onFile = `${identity.person.firstName} ${identity.person.lastName}`.trim();
      if (matchableName(onFile) === matchableName(name)) {
        matched(identity.personId, "Matched by the remembered user_id.");
      } else {
        const candidate = index.byPerson.get(identity.personId);
        steps.push(review(row, name, `user_id ${userId} belongs to ${onFile}. Check the name, and match by hand.`, [
          candidate ? candidateView(candidate) : { personId: identity.personId, name: onFile, sites: [] },
        ]));
      }
      continue;
    }

    const candidates = index.byName.get(matchableName(name)) ?? [];
    if (candidates.length === 0) {
      steps.push({
        line: row.line, name, action: "SKIP", message: "No one by this name is on a club roster or has a recent registration.", issuesNote: row.issuesNote,
      });
      continue;
    }
    const bySite = row.site ? candidates.filter((candidate) => matchesSite(row.site!, candidate.siteNames)) : candidates;
    if (bySite.length === 1) {
      matched(bySite[0]!.personId, row.site ? "Matched by name and location." : "Matched by name.");
      continue;
    }
    let message: string;
    if (candidates.length === 1) message = `One person has this name, but "${row.site}" isn't their club or church. Nothing was saved for this row; check it against the provider's records.`;
    else if (row.site) message = "More than one person has this name, and sites didn't narrow it to one. Nothing was saved for this row; check it against the provider's records.";
    else message = "More than one person has this name. Add a site, or review and match by hand.";
    steps.push(review(row, name, message, candidates.map(candidateView)));
  }

  // 2. A user_id the file uses for different people is never guessed.
  const peopleByUserId = new Map<string, Set<string>>();
  for (const step of resolved) {
    const people = peopleByUserId.get(step.userId) ?? new Set<string>();
    people.add(step.personId);
    peopleByUserId.set(step.userId, people);
  }
  // 3. Nor is a person already remembered under a different user_id.
  const resolvedPeople = [...new Set(resolved.map((step) => step.personId))];
  const rememberedAs = new Map((resolvedPeople.length > 0
    ? await prisma.externalIdentity.findMany({
      where: { provider: ROSTER_IMPORT_PROVIDER, providerScope: "", personId: { in: resolvedPeople } },
      select: { personId: true, externalId: true },
    })
    : []).map((identity) => [identity.personId as string, identity.externalId]));

  const userIdsByPerson = new Map<string, Set<string>>();
  for (const step of resolved) {
    const ids = userIdsByPerson.get(step.personId) ?? new Set<string>();
    ids.add(step.userId);
    userIdsByPerson.set(step.personId, ids);
  }

  const bestByPerson = new Map<string, RosterImportStep>();
  for (const step of resolved) {
    const sharedBy = peopleByUserId.get(step.userId)!;
    if (sharedBy.size > 1) {
      steps.push({
        line: step.line,
        name: step.name,
        action: "REVIEW",
        message: `user_id ${step.userId} is on more than one row in this file, for different people. Nothing was saved for this row; check it against the provider's records.`,
        candidates: [...sharedBy].map((personId) => {
          const candidate = index.byPerson.get(personId);
          return candidate ? candidateView(candidate) : { personId, name: step.name, sites: [] };
        }),
        issuesNote: step.issuesNote,
      });
      continue;
    }
    const remembered = rememberedAs.get(step.personId);
    if (remembered !== undefined && remembered !== step.userId) {
      const candidate = index.byPerson.get(step.personId);
      steps.push({
        line: step.line,
        name: step.name,
        action: "REVIEW",
        message: `This person is already remembered under user_id ${remembered}, not ${step.userId}. Nothing was saved for this row; check it against the provider's records.`,
        candidates: [candidate ? candidateView(candidate) : { personId: step.personId, name: step.name, sites: [] }],
        issuesNote: step.issuesNote,
      });
      continue;
    }
    // 4. The same person under different user_ids is never guessed either.
    const otherIds = [...userIdsByPerson.get(step.personId)!].filter((id) => id !== step.userId);
    if (otherIds.length > 0) {
      const candidate = index.byPerson.get(step.personId);
      steps.push({
        line: step.line,
        name: step.name,
        action: "REVIEW",
        message: `Also matched by user_id ${otherIds.join(", ")} in this file. Nothing was saved for this row; check it against the provider's records.`,
        candidates: [candidate ? candidateView(candidate) : { personId: step.personId, name: step.name, sites: [] }],
        issuesNote: step.issuesNote,
      });
      continue;
    }
    // 5. The same person and user_id twice: the later row is used.
    const earlier = bestByPerson.get(step.personId);
    if (earlier) {
      earlier.action = "SKIP";
      earlier.message = `Same person as row ${step.line}, which is used instead.`;
      delete earlier.personId;
    }
    bestByPerson.set(step.personId, step);
    steps.push(step);
  }

  const personIds = [...bestByPerson.keys()];
  const existing = new Set((personIds.length > 0
    ? await prisma.backgroundCheck.findMany({ where: { personId: { in: personIds } }, select: { personId: true } })
    : []).map((check) => check.personId));
  for (const step of bestByPerson.values()) {
    step.action = existing.has(step.personId!) ? "UPDATE" : "ADD";
    step.message = `${step.message} ${complianceLabels[step.compliance!]}.`;
  }
  return steps.sort((a, b) => a.line - b.line);
}

/** A roster-import save that stopped part-way. Every batch before `saved` is committed and audited. */
export class RosterImportSaveError extends Error {
  constructor(readonly saved: number, readonly total: number, options: { cause: unknown }) {
    super(`Saved ${saved} of ${total} rows before an error.`, options);
  }
}

/**
 * Records the matched rows in batches of 250, each its own transaction with
 * its own audit entry, so a failure part-way leaves a record of exactly what
 * was committed. The newest upload wins: a roster import clears a Sterling
 * check's dates on the same row. Each row's `user_id` is remembered against
 * its person, never by overwriting an id that belongs to someone else.
 */
export async function applyRosterBackgroundImport(steps: RosterImportStep[], actorUserId: string) {
  type SaveStep = RosterImportStep & { personId: string; compliance: BackgroundComplianceStatus };
  const toSave = steps.filter((step): step is SaveStep => (
    (step.action === "ADD" || step.action === "UPDATE") && Boolean(step.personId) && step.compliance !== undefined
  ));
  const totals = {
    added: steps.filter((step) => step.action === "ADD").length,
    updated: steps.filter((step) => step.action === "UPDATE").length,
    review: steps.filter((step) => step.action === "REVIEW").length,
    skipped: steps.filter((step) => step.action === "SKIP").length,
  };
  const prisma = getPrisma();

  // A fresh look at remembered ids just before saving, so nothing below can collide with one.
  const userIds = [...new Set(toSave.map((step) => step.userId).filter((id): id is string => Boolean(id)))];
  const personIds = [...new Set(toSave.map((step) => step.personId))];
  const [byExternalId, byPersonId] = await Promise.all([
    userIds.length > 0
      ? prisma.externalIdentity.findMany({
        where: { provider: ROSTER_IMPORT_PROVIDER, providerScope: "", externalId: { in: userIds } },
        select: { id: true, externalId: true, personId: true },
      })
      : [],
    personIds.length > 0
      ? prisma.externalIdentity.findMany({
        where: { provider: ROSTER_IMPORT_PROVIDER, providerScope: "", personId: { in: personIds } },
        select: { id: true, externalId: true, personId: true },
      })
      : [],
  ]);
  const identityByExternalId = new Map(byExternalId.map((identity) => [identity.externalId, identity]));
  const externalIdByPerson = new Map(byPersonId.map((identity) => [identity.personId as string, identity.externalId]));

  const batchCount = Math.ceil(toSave.length / ROSTER_IMPORT_BATCH_SIZE);
  let saved = 0;
  let idsNotRemembered = 0;
  try {
    for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
      const batch = toSave.slice(batchIndex * ROSTER_IMPORT_BATCH_SIZE, (batchIndex + 1) * ROSTER_IMPORT_BATCH_SIZE);
      const skippedIds = await prisma.$transaction(async (tx) => {
        const verifiedAt = new Date();
        const toVerify: string[] = [];
        const toCreate: Array<{ personId: string; provider: typeof ROSTER_IMPORT_PROVIDER; providerScope: string; externalId: string; lastVerifiedAt: Date }> = [];
        let notRemembered = 0;
        for (const step of batch) {
          const data = {
            provider: ROSTER_IMPORT_PROVIDER,
            checkedOn: null,
            expiresOn: null,
            complianceStatus: step.compliance,
            issuesNote: step.issuesNote ?? null,
            recordedByUserId: actorUserId,
          };
          await tx.backgroundCheck.upsert({
            where: { personId: step.personId },
            create: { personId: step.personId, ...data },
            update: data,
          });

          if (!step.userId) continue;
          const known = identityByExternalId.get(step.userId);
          const personHas = externalIdByPerson.get(step.personId);
          if (known?.personId === step.personId) {
            toVerify.push(known.id);
          } else if (known?.personId || (personHas !== undefined && personHas !== step.userId)) {
            // Belongs to someone else, or this person already has another id: never overwritten.
            notRemembered += 1;
          } else if (known) {
            // An id on file with no person: attach it rather than inserting a duplicate.
            const attached = await tx.externalIdentity.updateMany({
              where: { id: known.id, personId: null },
              data: { personId: step.personId, lastVerifiedAt: verifiedAt },
            });
            if (attached.count === 0) notRemembered += 1;
            else {
              identityByExternalId.set(step.userId, { ...known, personId: step.personId });
              externalIdByPerson.set(step.personId, step.userId);
            }
          } else {
            toCreate.push({ personId: step.personId, provider: ROSTER_IMPORT_PROVIDER, providerScope: "", externalId: step.userId, lastVerifiedAt: verifiedAt });
            externalIdByPerson.set(step.personId, step.userId);
          }
        }
        if (toVerify.length > 0) {
          await tx.externalIdentity.updateMany({ where: { id: { in: toVerify } }, data: { lastVerifiedAt: verifiedAt } });
        }
        if (toCreate.length > 0) {
          // ON CONFLICT DO NOTHING: an id or person that gained an identity since the fresh look is left as it is.
          const created = await tx.externalIdentity.createMany({ data: toCreate, skipDuplicates: true });
          notRemembered += toCreate.length - created.count;
        }
        await writeAuditLog({
          actorUserId,
          action: "BACKGROUND_CHECKS_IMPORTED",
          entityType: "BackgroundCheck",
          entityId: "roster-import",
          summary: `Recorded ${batch.length} background check compliance mark${batch.length === 1 ? "" : "s"} from a roster upload (batch ${batchIndex + 1} of ${batchCount}).`,
          metadata: {
            batch: batchIndex + 1,
            batches: batchCount,
            recorded: batch.length,
            recordedSoFar: saved + batch.length,
            toRecord: toSave.length,
            idsNotRemembered: notRemembered,
            ...totals,
          },
        }, tx);
        return notRemembered;
      }, ROSTER_IMPORT_TRANSACTION);
      saved += batch.length;
      idsNotRemembered += skippedIds;
    }
  } catch (error) {
    try {
      await writeAuditLog({
        actorUserId,
        action: "BACKGROUND_CHECKS_IMPORT_STOPPED",
        entityType: "BackgroundCheck",
        entityId: "roster-import",
        summary: `A roster upload stopped after recording ${saved} of ${toSave.length} background check compliance marks.`,
        metadata: { recorded: saved, toRecord: toSave.length, ...totals },
      });
    } catch {
      // Each committed batch already has its own audit entry; this one only adds where it stopped.
    }
    throw new RosterImportSaveError(saved, toSave.length, { cause: error });
  }
  if (batchCount === 0) {
    await writeAuditLog({
      actorUserId,
      action: "BACKGROUND_CHECKS_IMPORTED",
      entityType: "BackgroundCheck",
      entityId: "roster-import",
      summary: "A roster upload recorded no background check compliance marks.",
      metadata: { batch: 0, batches: 0, recorded: 0, recordedSoFar: 0, toRecord: 0, idsNotRemembered: 0, ...totals },
    });
  }
  return { added: totals.added, updated: totals.updated, batches: batchCount, idsNotRemembered };
}

/** Counts for the system administrator's page. Sterling checks go by date; roster import checks by their mark. */
export async function backgroundCheckSummary(today = calendarDateInEventTimeZone(new Date(), "America/Chicago")) {
  const soon = new Date(`${today}T12:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + 60);
  const soonDate = soon.toISOString().slice(0, 10);
  const prisma = getPrisma();
  const sterling = { complianceStatus: null };
  const [currentByDate, currentByMark, soonByDate, soonByMark, expired, notCompliant, lastRecorded, youthEvents] = await Promise.all([
    prisma.backgroundCheck.count({ where: { ...sterling, expiresOn: { gte: today } } }),
    prisma.backgroundCheck.count({ where: { complianceStatus: { in: ["CLEAR", "FLAGGED"] } } }),
    prisma.backgroundCheck.count({ where: { ...sterling, expiresOn: { gte: today, lte: soonDate } } }),
    prisma.backgroundCheck.count({ where: { complianceStatus: "FLAGGED" } }),
    prisma.backgroundCheck.count({ where: { ...sterling, expiresOn: { lt: today } } }),
    prisma.backgroundCheck.count({ where: { complianceStatus: "NOT_COMPLIANT" } }),
    prisma.backgroundCheck.findFirst({ orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
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
  return {
    current: currentByDate + currentByMark,
    expiringSoon: soonByDate + soonByMark,
    notCurrent: expired + notCompliant,
    lastRecordedAt: lastRecorded?.updatedAt.toISOString() ?? null,
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

const BIRTH_ANSWER_KEYS = ["date_of_birth", "birth_date", "birthdate", "dob"];
const AGE_ANSWER_KEYS = ["attendee_age", "age"];

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
      person: { select: { firstName: true, lastName: true, backgroundCheck: { select: { expiresOn: true, complianceStatus: true } } } },
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
    let age = typeof snapshot.ageOnEventDate === "number" ? snapshot.ageOnEventDate : null;
    if (age === null) {
      const birthKey = BIRTH_ANSWER_KEYS.find((key) => typeof responses[key] === "string" && responses[key]);
      const birthDate = birthKey ? normalizeCheckDate(String(responses[birthKey])) : null;
      if (birthDate) age = ageOn(birthDate, eventDate);
    }
    if (age === null) {
      const ageKey = AGE_ANSWER_KEYS.find((key) => responses[key] !== undefined && responses[key] !== "");
      age = ageKey ? ageFromAnswer(responses[ageKey]) : null;
    }
    const rosterAttendeeType = typeof snapshot.clubRosterMemberId === "string" ? rosterTypes.get(snapshot.clubRosterMemberId) ?? null : null;
    if (!attendeeIsAdult({ ageOnEventDate: age, rosterAttendeeType, attendeeType: attendee.attendeeType })) continue;
    adults += 1;
    const check = attendee.person.backgroundCheck;
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
 * to hide. "No record" is not counted as not in compliance; expiring soon is
 * counted on its own.
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
      person: { select: { backgroundCheck: { select: { complianceStatus: true, expiresOn: true, issuesNote: true } } } },
    },
  });
  const statuses: Record<string, { state: ClubComplianceState; note: string | null }> = {};
  let notInCompliance = 0;
  let expiringSoon = 0;
  for (const member of members) {
    const check = member.person?.backgroundCheck ?? null;
    const state = clubComplianceState(check, today);
    if (state === "NOT_COMPLIANT") notInCompliance += 1;
    if (state === "FLAGGED") expiringSoon += 1;
    statuses[member.id] = { state, note: options.includeNotes ? check?.issuesNote ?? null : null };
  }
  return { statuses, notInCompliance, expiringSoon };
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
