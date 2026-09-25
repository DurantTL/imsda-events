import "server-only";

import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { openBirthDate } from "@/modules/club-rosters/birth-dates";
import { ageOn, clubYearFor } from "@/modules/club-rosters/domain";
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
    select: { personId: true, expiresOn: true },
  })).map((check) => [check.personId, check.expiresOn]));
  for (const step of bestByPerson.values()) {
    if (step.action === "SKIP") continue;
    const onFile = existing.get(step.personId!);
    if (onFile && onFile >= step.expiresOn!) {
      step.action = "SKIP";
      step.message = "A check lasting at least as long is already on file.";
      delete step.personId;
    } else {
      step.action = onFile ? "UPDATE" : "ADD";
      step.message = `Check good through ${step.expiresOn}.`;
    }
  }
  return steps.sort((a, b) => a.line - b.line);
}

/** Records the matched rows. Only the dates are kept; the file is not. */
export async function applySterlingImport(steps: SterlingImportStep[], actorUserId: string) {
  const toSave = steps.filter((step) => step.action !== "SKIP" && step.personId && step.expiresOn);
  await getPrisma().$transaction(async (tx) => {
    for (const step of toSave) {
      const data = { checkedOn: step.checkedOn ?? null, expiresOn: step.expiresOn!, recordedByUserId: actorUserId };
      await tx.backgroundCheck.upsert({
        where: { personId: step.personId! },
        create: { personId: step.personId!, provider: "STERLING", ...data },
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
  });
  return {
    added: steps.filter((step) => step.action === "ADD").length,
    updated: steps.filter((step) => step.action === "UPDATE").length,
  };
}

// --- Roster import (#427) ---

const ROSTER_IMPORT_PROVIDER = "ROSTER_IMPORT";
/** Upserts run this many rows per transaction, so a 5,000-row confirm doesn't hold one giant transaction open. */
const ROSTER_IMPORT_BATCH_SIZE = 250;

export type RosterImportCandidate = { personId: string; site: string | null };

export type RosterImportStep = {
  line: number;
  name: string;
  action: "ADD" | "UPDATE" | "SKIP" | "REVIEW";
  message: string;
  personId?: string;
  userId?: string | null;
  compliant?: boolean;
  active?: boolean;
  issuesNote?: string | null;
  /** Only on a REVIEW row: who it might be, so staff can pick by hand. Never picked automatically. */
  candidates?: RosterImportCandidate[];
};

type NameCandidate = { personId: string; siteNames: Set<string> };

/**
 * Every adult on a current club roster or with an active registration,
 * indexed by normalized name, built once so matching 5,000 rows is a map
 * lookup each instead of a query each (#427).
 */
async function rosterBackgroundNameIndex(): Promise<Map<string, NameCandidate[]>> {
  const prisma = getPrisma();
  const clubYear = clubYearFor(new Date());
  const [rosterMembers, attendees] = await Promise.all([
    prisma.clubRosterMember.findMany({
      where: { clubYear, status: "ACTIVE", attendeeType: { in: ["ADULT", "STAFF"] }, personId: { not: null } },
      select: {
        personId: true,
        person: { select: { firstName: true, lastName: true } },
        organization: { select: { name: true, parentOrganization: { select: { name: true } } } },
      },
    }),
    prisma.registrationAttendee.findMany({
      where: { registration: { status: { in: [...activeRegistrationStatuses] } } },
      select: {
        personId: true,
        attendeeType: true,
        profileSnapshot: true,
        formResponses: true,
        person: { select: { firstName: true, lastName: true } },
        registration: {
          select: { clubRegistration: { select: { organization: { select: { name: true, parentOrganization: { select: { name: true } } } } } } },
        },
      },
    }),
  ]);

  const byPerson = new Map<string, { firstName: string; lastName: string; siteNames: Set<string> }>();
  const remember = (personId: string, firstName: string, lastName: string, sites: Array<string | null | undefined>) => {
    let entry = byPerson.get(personId);
    if (!entry) {
      entry = { firstName, lastName, siteNames: new Set() };
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
      if (birthDate) age = ageOn(birthDate, calendarDateInEventTimeZone(new Date(), "America/Chicago"));
    }
    if (!attendeeIsAdult({ ageOnEventDate: age, attendeeType: attendee.attendeeType })) continue;
    if (!attendee.person) continue;
    const club = attendee.registration.clubRegistration?.organization;
    remember(attendee.personId, attendee.person.firstName, attendee.person.lastName, [club?.name, club?.parentOrganization?.name]);
  }

  const index = new Map<string, NameCandidate[]>();
  for (const [personId, entry] of byPerson) {
    const key = matchableName(`${entry.firstName} ${entry.lastName}`);
    const list = index.get(key) ?? [];
    list.push({ personId, siteNames: entry.siteNames });
    index.set(key, list);
  }
  return index;
}

/**
 * What a roster-import upload would do, row by row (#427). A remembered
 * `user_id` matches first; otherwise a row is matched by normalized name,
 * narrowed by `sites` against a candidate's club or sponsoring church when
 * more than one person shares the name. Still ambiguous, or no match at all,
 * is listed as "needs review" with its candidates — never guessed.
 */
export async function planRosterBackgroundImport(rows: RosterBackgroundCsvRow[]): Promise<RosterImportStep[]> {
  const prisma = getPrisma();
  const steps: RosterImportStep[] = [];
  const bestByPerson = new Map<string, RosterImportStep>();

  const userIds = [...new Set(rows.map((row) => row.userId).filter((id): id is string => Boolean(id)))];
  const identities = userIds.length > 0
    ? await prisma.externalIdentity.findMany({
      where: { provider: ROSTER_IMPORT_PROVIDER, providerScope: "", externalId: { in: userIds }, personId: { not: null } },
      select: { externalId: true, personId: true },
    })
    : [];
  const personByUserId = new Map(identities.map((identity) => [identity.externalId, identity.personId as string]));
  const nameIndex = await rosterBackgroundNameIndex();

  for (const row of rows) {
    const name = `${row.firstName} ${row.lastName}`.trim() || "(no name)";
    const skip = (message: string) => steps.push({ line: row.line, name, action: "SKIP", message });
    if (row.problems.length > 0) {
      skip(row.problems.join(" "));
      continue;
    }

    let personId = row.userId ? personByUserId.get(row.userId) ?? null : null;
    let matchMessage = "Matched by the remembered user_id.";
    if (!personId) {
      const candidates = nameIndex.get(matchableName(name)) ?? [];
      if (candidates.length === 0) {
        skip("No one by this name is on a club roster or has an active registration.");
        continue;
      }
      if (candidates.length === 1) {
        personId = candidates[0]!.personId;
        matchMessage = "Matched by name.";
      } else {
        const bySite = row.site ? candidates.filter((candidate) => matchesSite(row.site!, candidate.siteNames)) : [];
        if (bySite.length === 1) {
          personId = bySite[0]!.personId;
          matchMessage = "Matched by name and location.";
        } else {
          steps.push({
            line: row.line,
            name,
            action: "REVIEW",
            message: row.site
              ? "More than one person has this name, and sites didn't narrow it to one. Review and match by hand."
              : "More than one person has this name. Add a site, or review and match by hand.",
            candidates: candidates.map((candidate) => ({ personId: candidate.personId, site: [...candidate.siteNames][0] ?? null })),
          });
          continue;
        }
      }
    }

    const step: RosterImportStep = {
      line: row.line,
      name,
      action: "ADD",
      message: matchMessage,
      personId,
      userId: row.userId,
      compliant: row.compliant!,
      active: row.active,
      issuesNote: row.issuesNote,
    };
    const earlier = bestByPerson.get(personId);
    if (earlier) {
      earlier.action = "SKIP";
      earlier.message = `Same person as row ${step.line}, which is used instead.`;
      delete earlier.personId;
    }
    bestByPerson.set(personId, step);
    steps.push(step);
  }

  const personIds = [...bestByPerson.keys()];
  const existing = new Set((personIds.length > 0
    ? await prisma.backgroundCheck.findMany({ where: { personId: { in: personIds } }, select: { personId: true } })
    : []).map((check) => check.personId));
  for (const step of bestByPerson.values()) {
    step.action = existing.has(step.personId!) ? "UPDATE" : "ADD";
    step.message = `${step.message} ${step.compliant ? "Clear" : "Needs attention"}${step.active ? "" : " · inactive"}.`;
  }
  return steps.sort((a, b) => a.line - b.line);
}

/**
 * Records the matched rows in batches, and remembers each row's `user_id`
 * against the person it matched so the next upload matches on it first.
 */
export async function applyRosterBackgroundImport(steps: RosterImportStep[], actorUserId: string) {
  const toSave = steps.filter((step): step is RosterImportStep & { personId: string; compliant: boolean; active: boolean } => (
    (step.action === "ADD" || step.action === "UPDATE") && Boolean(step.personId) && step.compliant !== undefined && step.active !== undefined
  ));
  const prisma = getPrisma();
  for (let start = 0; start < toSave.length; start += ROSTER_IMPORT_BATCH_SIZE) {
    const batch = toSave.slice(start, start + ROSTER_IMPORT_BATCH_SIZE);
    await prisma.$transaction(async (tx) => {
      for (const step of batch) {
        const data = {
          complianceStatus: step.compliant ? ("CLEAR" as const) : ("NEEDS_ATTENTION" as const),
          issuesNote: step.issuesNote ?? null,
          active: step.active,
          recordedByUserId: actorUserId,
        };
        await tx.backgroundCheck.upsert({
          where: { personId: step.personId },
          create: { personId: step.personId, provider: ROSTER_IMPORT_PROVIDER, ...data },
          update: data,
        });
        if (step.userId) {
          await tx.externalIdentity.upsert({
            where: { personId_provider_providerScope: { personId: step.personId, provider: ROSTER_IMPORT_PROVIDER, providerScope: "" } },
            create: { personId: step.personId, provider: ROSTER_IMPORT_PROVIDER, providerScope: "", externalId: step.userId, lastVerifiedAt: new Date() },
            update: { externalId: step.userId, lastVerifiedAt: new Date() },
          });
        }
      }
    });
  }
  await writeAuditLog({
    actorUserId,
    action: "BACKGROUND_CHECKS_IMPORTED",
    entityType: "BackgroundCheck",
    entityId: "roster-import",
    summary: `Recorded ${toSave.length} background check compliance mark${toSave.length === 1 ? "" : "s"} from a roster upload.`,
    metadata: {
      added: steps.filter((step) => step.action === "ADD").length,
      updated: steps.filter((step) => step.action === "UPDATE").length,
      review: steps.filter((step) => step.action === "REVIEW").length,
      skipped: steps.filter((step) => step.action === "SKIP").length,
    },
  });
  return {
    added: steps.filter((step) => step.action === "ADD").length,
    updated: steps.filter((step) => step.action === "UPDATE").length,
  };
}

/** Counts for the system administrator's page. */
export async function backgroundCheckSummary(today = calendarDateInEventTimeZone(new Date(), "America/Chicago")) {
  const soon = new Date(`${today}T12:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + 60);
  const soonDate = soon.toISOString().slice(0, 10);
  const prisma = getPrisma();
  const [current, expiringSoon, expired, lastRecorded, youthEvents] = await Promise.all([
    prisma.backgroundCheck.count({ where: { expiresOn: { gte: today } } }),
    prisma.backgroundCheck.count({ where: { expiresOn: { gte: today, lte: soonDate } } }),
    prisma.backgroundCheck.count({ where: { expiresOn: { lt: today } } }),
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
  return { current, expiringSoon, expired, lastRecordedAt: lastRecorded?.updatedAt.toISOString() ?? null, events };
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
      person: { select: { firstName: true, lastName: true, backgroundCheck: { select: { expiresOn: true } } } },
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
 * Needs attention, or No record, keyed by roster member id. `includeNotes`
 * must be decided by the caller from who is asking — the note is staff only,
 * and a club director never receives it, not even a blank one to hide.
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
      person: { select: { backgroundCheck: { select: { complianceStatus: true, active: true, expiresOn: true, issuesNote: true } } } },
    },
  });
  const statuses: Record<string, { state: ClubComplianceState; note: string | null }> = {};
  let notInCompliance = 0;
  for (const member of members) {
    const check = member.person?.backgroundCheck ?? null;
    const state = clubComplianceState(check, today);
    if (state === "NEEDS_ATTENTION") notInCompliance += 1;
    statuses[member.id] = { state, note: options.includeNotes ? check?.issuesNote ?? null : null };
  }
  return { statuses, notInCompliance };
}
