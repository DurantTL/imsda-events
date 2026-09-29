import { beforeEach, describe, expect, it, vi } from "vitest";

// --- A small in-memory fake Prisma, just enough for the background-checks
// repository's own queries (#527). The real-database behaviour (the
// migration, raw SQL, locks) is proven by `npm run test:background-check-list`
// (scripts/verify-background-check-list.ts); this fake covers the rules. ---

type Row = Record<string, unknown>;

function nextIdFactory() {
  let counter = 0;
  return (prefix: string) => `${prefix}-${(counter += 1)}`;
}

/** The fake's stand-in for the refresh's coarse SQL name filter. */
function compactName(first: string, last: string) {
  return `${first} ${last}`.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function valueMatches(value: unknown, condition: unknown): boolean {
  if (condition === null) return value === null || value === undefined;
  if (condition && typeof condition === "object" && !(condition instanceof Date)) {
    const c = condition as Row;
    if ("in" in c && !(c.in as unknown[]).includes(value)) return false;
    if ("not" in c) {
      if (c.not === null) { if (value === null || value === undefined) return false; }
      else if (value === c.not) return false;
    }
    if ("endsWith" in c && !String(value ?? "").endsWith(c.endsWith as string)) return false;
    if ("gte" in c && !((value as string) >= (c.gte as string))) return false;
    if ("lte" in c && !((value as string) <= (c.lte as string))) return false;
    if ("lt" in c && !((value as string) < (c.lt as string))) return false;
    return true;
  }
  return value === condition;
}

function makeFakeDb() {
  const nextId = nextIdFactory();
  const persons = new Map<string, Row>();
  const uploads = new Map<string, Row>();
  const entries = new Map<string, Row>();
  const matches = new Map<string, Row>();
  const reviews = new Map<string, Row>();
  const identities = new Map<string, Row>();
  const rosterMembers: Row[] = [];
  const extraOrganizations: string[] = [];
  const attendees: Row[] = [];
  const events = new Map<string, Row>();
  const lock = { held: false };

  const matchForEntry = (entryId: unknown) => [...matches.values()].find((match) => match.entryId === entryId) ?? null;
  const matchForPerson = (personId: unknown) => [...matches.values()].find((match) => match.personId === personId) ?? null;

  const reviewForEntry = (entryId: unknown) => [...reviews.values()].find((review) => review.entryId === entryId) ?? null;

  function entryWhere(entry: Row, where: Row = {}): boolean {
    for (const [key, condition] of Object.entries(where)) {
      if (key === "OR") {
        if (!(condition as Row[]).some((option) => entryWhere(entry, option))) return false;
        continue;
      }
      if (key === "match") {
        if (condition === null && matchForEntry(entry.id)) return false;
        continue;
      }
      if (key === "review") {
        const review = reviewForEntry(entry.id);
        if (condition === null) { if (review) return false; continue; }
        if (!review) return false;
        for (const [field, fieldCondition] of Object.entries(condition as Row)) if (!valueMatches(review[field], fieldCondition)) return false;
        continue;
      }
      if (!valueMatches(entry[key], condition)) return false;
    }
    return true;
  }

  function withEntryRelations(entry: Row) {
    const match = matchForEntry(entry.id);
    return {
      ...entry,
      match: match ? { personId: match.personId, matchedBy: match.matchedBy } : null,
      review: reviewForEntry(entry.id) ? { ...reviewForEntry(entry.id) } : null,
      upload: uploads.get(entry.uploadId as string) ?? { createdAt: new Date(0) },
    };
  }

  function matchWhere(match: Row, where: Row = {}): boolean {
    if (where.OR) return (where.OR as Row[]).some((condition) => matchWhere(match, condition));
    for (const [key, condition] of Object.entries(where)) {
      if (key === "entry") {
        const entry = entries.get(match.entryId as string);
        if (!entry || !entryWhere(entry, condition as Row)) return false;
        continue;
      }
      if (!valueMatches(match[key], condition)) return false;
    }
    return true;
  }

  function withMatchRelations(match: Row) {
    const person = persons.get(match.personId as string) ?? { firstName: "", lastName: "" };
    return { ...match, entry: { ...entries.get(match.entryId as string) }, person: { ...person } };
  }

  function identityWhere(identity: Row, where: Row = {}): boolean {
    for (const [key, condition] of Object.entries(where)) {
      if (key === "NOT") {
        if (identityWhere(identity, condition as Row)) return false;
        continue;
      }
      if (!valueMatches(identity[key], condition)) return false;
    }
    return true;
  }

  function rosterWhere(member: Row, where: Row): boolean {
    if (where.OR && !(where.OR as Row[]).some((option) => rosterWhere(member, option))) return false;
    if (where.sealedBirthDate !== undefined && !valueMatches(member.sealedBirthDate, where.sealedBirthDate)) return false;
    if (where.organizationId && member.organizationId !== where.organizationId) return false;
    const clubYearWhere = where.clubYear as string | { in: string[] } | undefined;
    if (typeof clubYearWhere === "string" && member.clubYear !== clubYearWhere) return false;
    if (clubYearWhere && typeof clubYearWhere === "object" && !clubYearWhere.in.includes(member.clubYear as string)) return false;
    if (where.status && member.status !== where.status) return false;
    if (where.id && !valueMatches(member.id, where.id)) return false;
    if (where.personId !== undefined && !valueMatches(member.personId, where.personId)) return false;
    const attendeeType = where.attendeeType as { in?: string[] } | undefined;
    if (attendeeType?.in && !attendeeType.in.includes(member.attendeeType as string)) return false;
    return true;
  }

  function attendeeWhere(attendee: Row, where: Row): boolean {
    const event = attendee.event as Row | undefined;
    const endsAt = where.event as { endsAt?: { gte: Date } } | undefined;
    if (endsAt?.endsAt && !(event && (event.endsAt as Date) >= endsAt.endsAt.gte)) return false;
    if (where.eventId && attendee.eventId !== where.eventId) return false;
    if (where.personId !== undefined && !valueMatches(attendee.personId, where.personId)) return false;
    const registration = attendee.registration as Row;
    const regWhere = where.registration as Row | undefined;
    if (regWhere?.status) {
      const status = regWhere.status as { in: string[] };
      if (!status.in.includes(registration.status as string)) return false;
    }
    if (regWhere?.clubRegistration) {
      const clubReg = registration.clubRegistration as Row | null;
      const wantOrg = (regWhere.clubRegistration as Row).organizationId;
      if (clubReg?.organizationId !== wantOrg) return false;
    }
    return true;
  }

  const entryFindMany = async ({ where }: { where?: Row } = {}) => [...entries.values()]
    .filter((entry) => entryWhere(entry, where))
    .map(withEntryRelations);

  const client = {
    person: {
      findUnique: async ({ where }: { where: { id: string } }) => (persons.get(where.id) ? { ...persons.get(where.id) } : null),
      findMany: async ({ where }: { where?: { id?: { in: string[] } } } = {}) => {
        let list = [...persons.values()];
        if (where?.id?.in) list = list.filter((person) => where.id!.in.includes(person.id as string));
        return list.map((person) => {
          const match = matchForPerson(person.id);
          return {
            ...person,
            backgroundCheckMatch: match ? { matchedBy: match.matchedBy, entry: { ...entries.get(match.entryId as string) } } : null,
            clubRosterMemberships: rosterMembers
              .filter((member) => member.personId === person.id && member.status === "ACTIVE")
              .map((member) => ({ organization: { name: (member.organization as Row).name } })),
          };
        });
      },
    },
    backgroundCheckUpload: {
      findFirst: async () => {
        const list = [...uploads.values()].sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime() || String(b.id).localeCompare(String(a.id)));
        return list[0] ? { ...list[0] } : null;
      },
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("upload"), createdAt: new Date(Date.now() + uploads.size), ...data };
        uploads.set(row.id, row);
        return { ...row };
      },
    },
    backgroundCheckEntry: {
      findMany: entryFindMany,
      createMany: async ({ data }: { data: Row[] }) => {
        for (const row of data) {
          const id = nextId("entry");
          entries.set(id, { id, createdAt: new Date(), updatedAt: new Date(), ...row });
        }
        return { count: data.length };
      },
      deleteMany: async ({ where }: { where: Row }) => {
        let removed = 0;
        for (const [id, entry] of [...entries.entries()]) {
          if (!entryWhere(entry, where)) continue;
          entries.delete(id);
          for (const [matchId, match] of [...matches.entries()]) if (match.entryId === id) matches.delete(matchId);
          for (const [reviewId, review] of [...reviews.entries()]) if (review.entryId === id) reviews.delete(reviewId);
          removed += 1;
        }
        return { count: removed };
      },
      count: async ({ where }: { where: Row }) => (await entryFindMany({ where })).length,
    },
    backgroundCheckMatch: {
      findFirst: async () => {
        const list = [...matches.values()].sort((a, b) => (b.updatedAt as Date).getTime() - (a.updatedAt as Date).getTime());
        return list[0] ? { ...list[0] } : null;
      },
      findUnique: async ({ where }: { where: { id: string } }) => (matches.get(where.id) ? withMatchRelations(matches.get(where.id)!) : null),
      findMany: async ({ where }: { where?: Row } = {}) => [...matches.values()].filter((match) => matchWhere(match, where)).map(withMatchRelations),
      createMany: async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => {
        for (const row of data) {
          if (matchForPerson(row.personId) || matchForEntry(row.entryId)) {
            if (skipDuplicates) continue;
            throw new Error("Unique constraint failed on BackgroundCheckMatch");
          }
          const id = nextId("match");
          matches.set(id, { id, createdAt: new Date(), updatedAt: new Date(), ...row });
        }
        return { count: data.length };
      },
      create: async ({ data }: { data: Row }) => {
        if (matchForPerson(data.personId) || matchForEntry(data.entryId)) throw new Error("Unique constraint failed on BackgroundCheckMatch");
        const id = nextId("match");
        const row = { id, createdAt: new Date(), updatedAt: new Date(), ...data };
        matches.set(id, row);
        return { ...row };
      },
      deleteMany: async ({ where }: { where: Row }) => {
        let removed = 0;
        for (const [id, row] of [...matches.entries()]) {
          if (matchWhere(row, where)) { matches.delete(id); removed += 1; }
        }
        return { count: removed };
      },
      count: async ({ where }: { where?: Row } = {}) => [...matches.values()].filter((match) => matchWhere(match, where)).length,
    },
    backgroundCheckReview: {
      findMany: async ({ where }: { where?: Row } = {}) => [...reviews.values()]
        .filter((review) => Object.entries(where ?? {}).every(([field, condition]) => valueMatches(review[field], condition)))
        .sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime())
        .map((review) => ({ ...review, entry: { ...entries.get(review.entryId as string) } })),
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const review = reviews.get(where.id);
        if (!review) throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
        Object.assign(review, data);
        return { ...review };
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const review = reviews.get(where.id);
        if (!review) return null;
        return { ...review, entry: { ...entries.get(review.entryId as string) } };
      },
      createMany: async ({ data }: { data: Row[] }) => {
        for (const row of data) {
          if (reviewForEntry(row.entryId)) continue; // One per entry; always skipDuplicates in the repository.
          const id = nextId("review");
          reviews.set(id, { id, createdAt: new Date(), ...row });
        }
        return { count: data.length };
      },
      deleteMany: async ({ where }: { where: Row }) => {
        let removed = 0;
        for (const [id, review] of [...reviews.entries()]) {
          if (!Object.entries(where).every(([field, condition]) => valueMatches(review[field], condition))) continue;
          reviews.delete(id);
          removed += 1;
        }
        return { count: removed };
      },
      count: async ({ where }: { where?: Row } = {}) => [...reviews.values()]
        .filter((review) => Object.entries(where ?? {}).every(([field, condition]) => valueMatches(review[field], condition))).length,
    },
    externalIdentity: {
      findMany: async ({ where }: { where: Row }) => [...identities.values()]
        .filter((identity) => identityWhere(identity, where))
        .map((identity) => ({ ...identity, person: identity.personId ? persons.get(identity.personId as string) ?? null : null })),
      deleteMany: async ({ where }: { where: Row }) => {
        let removed = 0;
        for (const [id, identity] of [...identities.entries()]) {
          if (!identityWhere(identity, where)) continue;
          identities.delete(id);
          removed += 1;
        }
        return { count: removed };
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        let updated = 0;
        for (const identity of identities.values()) {
          if (!identityWhere(identity, where)) continue;
          Object.assign(identity, data);
          updated += 1;
        }
        return { count: updated };
      },
      createMany: async ({ data }: { data: Row[] }) => {
        let created = 0;
        for (const row of data) {
          const clash = [...identities.values()].some((identity) => (
            identity.provider === row.provider && identity.providerScope === row.providerScope
            && (identity.externalId === row.externalId || identity.personId === row.personId)
          ));
          if (clash) continue;
          const id = nextId("identity");
          identities.set(id, { id, ...row });
          created += 1;
        }
        return { count: created };
      },
      upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
        const key = where.provider_providerScope_externalId as Row;
        const existing = [...identities.values()].find((identity) => (
          identity.provider === key.provider && identity.providerScope === key.providerScope && identity.externalId === key.externalId
        ));
        if (existing) { Object.assign(existing, update); return { ...existing }; }
        const id = nextId("identity");
        const row = { id, ...create };
        identities.set(id, row);
        return { ...row };
      },
    },
    organization: {
      // The directory: the seeded extra organizations plus every roster member's club and church.
      findMany: async () => {
        const names = new Set<string>(extraOrganizations);
        for (const member of rosterMembers) {
          const organization = member.organization as { name: string; parentOrganization: { name: string } | null };
          names.add(organization.name);
          if (organization.parentOrganization) names.add(organization.parentOrganization.name);
        }
        return [...names].map((name) => ({ name }));
      },
    },
    clubRosterMember: {
      findMany: async ({ where }: { where: Row }) => rosterMembers.filter((member) => rosterWhere(member, where)).map((member) => ({ ...member })),
    },
    registrationAttendee: {
      findMany: async ({ where }: { where: Row }) => attendees.filter((attendee) => attendeeWhere(attendee, where)).map((attendee) => ({ ...attendee })),
    },
    event: {
      findUnique: async ({ where }: { where: { id: string } }) => (events.get(where.id) ? { ...events.get(where.id) } : null),
      findMany: async ({ where }: { where?: Row } = {}) => {
        let list = [...events.values()];
        if (where?.checksAdultBackgrounds) list = list.filter((event) => event.checksAdultBackgrounds);
        const endsAt = where?.endsAt as { gte: Date } | undefined;
        if (endsAt) list = list.filter((event) => (event.endsAt as Date) >= endsAt.gte);
        return list.map((event) => ({ ...event }));
      },
    },
    // Advisory locks are a no-op here; the normalizedName backfill is applied
    // by hand, from the ids and TypeScript-computed names it passes.
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join("?").includes('SET "normalizedName"')) {
        const [ids, names] = values as [string[], string[]];
        ids.forEach((id, index) => { const entry = entries.get(id); if (entry && entry.normalizedName == null) entry.normalizedName = names[index]; });
        return ids.length;
      }
      return 0;
    },
    // The list lock's try-lock (held by a pretend upload when `lock.held`),
    // and the refresh's coarse name filter: people whose compacted name is one asked for.
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join("?").includes("pg_try_advisory_xact_lock_shared")) return [{ locked: !lock.held }];
      // The lookup's coarse last-name filter.
      if (strings.join("?").includes('normalize("lastName"')) {
        const wanted = values[0] as string;
        return [...persons.values()]
          .filter((person) => compactName("", person.lastName as string) === wanted)
          .map((person) => ({ id: person.id, firstName: person.firstName, lastName: person.lastName }));
      }
      const compacts = values.find((value): value is string[] => Array.isArray(value)) ?? [];
      return [...persons.values()]
        .filter((person) => compacts.includes(compactName(person.firstName as string, person.lastName as string)))
        .map((person) => ({ id: person.id, firstName: person.firstName, lastName: person.lastName }));
    },
  };
  (client as { $transaction?: unknown }).$transaction = async (work: (tx: typeof client) => Promise<unknown>) => work(client);

  return { client, lock, seed: { persons, uploads, entries, matches, reviews, identities, rosterMembers, attendees, events, extraOrganizations } };
}

// --- Wiring: getPrisma() returns whichever fake is current for the test. ---

let currentClient: unknown;
const auditLog = vi.fn();

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => currentClient }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: (...args: unknown[]) => auditLog(...args) }));
vi.mock("@/modules/club-rosters/birth-dates", () => ({
  sealBirthDate: (value: string) => `sealed:${value}`,
  openBirthDate: (sealed: string) => {
    if (!sealed.startsWith("sealed:")) throw new Error("not sealed");
    return sealed.slice("sealed:".length);
  },
}));

import {
  attendeeIsAdult,
  backgroundCheckIdentityKey,
  backgroundCheckState,
  dedupeListRows,
  isRememberedIdentityKey,
  candidateSiteStems,
  directorySiteStems,
  firstNameVariant,
  matchesSite,
  parseLookupName,
  siteStems,
  backgroundFlagsCsv,
  clubComplianceState,
  complianceReminders,
  detectBackgroundCsvFormat,
  isClearStatus,
  matchableName,
  normalizeCheckDate,
  parseRosterBackgroundCsv,
  parseSterlingCsv,
  rosterRowToListRow,
  RosterBackgroundCsvError,
  sterlingRowToListRow,
  SterlingCsvError,
} from "@/modules/background-checks/domain";
import {
  applyBackgroundCheckUpload,
  backgroundCheckSummary,
  backgroundCheckUploadFingerprint,
  clubComplianceReminderCounts,
  clubPortalComplianceReminderCounts,
  clubPortalComplianceStatuses,
  clubRosterComplianceStatuses,
  listBackgroundCheckReviews,
  listEventBackgroundFlags,
  listManualBackgroundCheckMatches,
  listNameOnlyBackgroundCheckMatches,
  listUnmatchedBackgroundCheckEntries,
  lookupBackgroundCheckName,
  planBackgroundCheckUpload,
  refreshBackgroundCheckMatchForPerson,
  rejectNameOnlyBackgroundCheckMatch,
  rematchBackgroundCheckList,
  resolveBackgroundCheckReview,
  undoManualBackgroundCheckMatch,
} from "@/modules/background-checks/repository";
import { BackgroundCheckOperationError } from "@/modules/background-checks/errors";
import { clubCapabilities } from "@/modules/organizations/director-grants-domain";
import { clubYearFor } from "@/modules/club-rosters/domain";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Sterling Volunteers CSV (#388)", () => {
  it("reads common column names, full names, and US dates", () => {
    const rows = parseSterlingCsv([
      "Volunteer Name,Email Address,Date of Birth,Date Completed,Expiration Date,Status",
      '"Rivera, Ana",ANA@example.test,4/17/1985,9/1/2026 10:15 AM,9/1/2029,Clear',
      "Sam Lee,,,, 2029-02-30,",
    ].join("\n"));
    expect(rows[0]).toMatchObject({
      line: 2, firstName: "Ana", lastName: "Rivera", email: "ana@example.test", birthDate: "1985-04-17",
      checkedOn: "2026-09-01", expiresOn: "2029-09-01", status: "Clear", problems: [],
    });
    expect(rows[1]!.problems).toEqual([
      "An email or birth date is needed to match the person.",
      "The expiration date isn't a date.",
    ]);
  });

  it("explains a file it can't use", () => {
    expect(() => parseSterlingCsv("First name,Last name,Email\nA,B,c@example.test")).toThrow(SterlingCsvError);
    expect(() => parseSterlingCsv("Email,Expiration date\nc@example.test,2029-01-01")).toThrow(/First name and Last name/);
    expect(() => parseSterlingCsv("First name,Last name,Expiration date\nA,B,2029-01-01")).toThrow(/Email or Birth date/);
  });

  it("only treats clear statuses as passed", () => {
    expect(isClearStatus(null)).toBe(true);
    expect(isClearStatus("Meets Criteria")).toBe(true);
    expect(isClearStatus("Review")).toBe(false);
    expect(normalizeCheckDate("2/29/2027")).toBeNull();
  });

  it("never reads a two-digit year as a birth-date century (#424)", () => {
    expect(normalizeCheckDate("6/30/28")).toBeNull();
    expect(normalizeCheckDate("6/30/2028")).toBe("2028-06-30");
    expect(normalizeCheckDate("2031-02-14")).toBe("2031-02-14");
    const rows = parseSterlingCsv("First name,Last name,Email,Expiration date\nAna,Rivera,ana@example.test,6/30/28\nBo,Lee,bo@example.test,6/30/2028");
    expect(rows[0]!.expiresOn).toBeNull();
    expect(rows[0]!.problems).toContain("The expiration date isn't a date.");
    expect(rows[1]).toMatchObject({ expiresOn: "2028-06-30", problems: [] });
  });

  it("is current through the expiration day", () => {
    expect(backgroundCheckState({ expiresOn: "2026-10-04" }, "2026-10-04")).toBe("CURRENT");
    expect(backgroundCheckState({ expiresOn: "2026-10-03" }, "2026-10-04")).toBe("EXPIRED");
    expect(backgroundCheckState(null, "2026-10-04")).toBe("MISSING");
  });
});

describe("who is an adult at a youth event (#388)", () => {
  it("lets a known age decide, then the roster type, then the attendee type", () => {
    expect(attendeeIsAdult({ ageOnEventDate: 16, rosterAttendeeType: "STAFF", attendeeType: "Staff" })).toBe(false);
    expect(attendeeIsAdult({ ageOnEventDate: 18, attendeeType: "Pathfinder" })).toBe(true);
    expect(attendeeIsAdult({ ageOnEventDate: null, rosterAttendeeType: "ADULT", attendeeType: "Pathfinder" })).toBe(true);
    expect(attendeeIsAdult({ ageOnEventDate: null, rosterAttendeeType: "YOUTH", attendeeType: "Staff" })).toBe(false);
    expect(attendeeIsAdult({ ageOnEventDate: null, attendeeType: "Parent driver" })).toBe(true);
    expect(attendeeIsAdult({ ageOnEventDate: null, attendeeType: "Pathfinder" })).toBe(false);
  });
});

describe("roster import CSV (#427)", () => {
  const rosterCsv = (...rows: string[]) => parseRosterBackgroundCsv(
    ["user_id,user_last,user_first,roles,sites,user_active,compliance,issues", ...rows].join("\n"),
  );

  it("reads the real template, maps y/!/n compliance, and ignores user_active", () => {
    const rows = rosterCsv(
      "111111,Swanson,Joe,something,Church,y,y,notes",
      "222222,Lee,Sam,,,n,N,under review",
      "333333,Cho,Kim,,,y,!,Training expires 2026-11-01",
      "444444,Park,Dee,,,,YES,",
      "555555,Ng,Bo,,,,no,",
      ",Nobody,Pat,,,,,",
    );
    expect(rows[0]).toEqual({
      line: 2, userId: "111111", firstName: "Joe", lastName: "Swanson", roles: "something", site: "Church",
      compliance: "CLEAR", issuesNote: "notes", problems: [],
    });
    expect(rows[1]).toMatchObject({ userId: "222222", compliance: "NOT_COMPLIANT", site: null, problems: [] });
    expect(rows[2]).toMatchObject({ userId: "333333", compliance: "FLAGGED", issuesNote: "Training expires 2026-11-01", problems: [] });
    expect(rows[5]!.problems).toEqual(["A user_id is needed so this person is remembered next time.", 'compliance must be "y", "n", or "!".']);
  });

  it("explains a file it can't use", () => {
    expect(() => parseRosterBackgroundCsv("user_id,user_last,user_first\n1,A,B")).toThrow(RosterBackgroundCsvError);
    expect(() => parseRosterBackgroundCsv("user_last,user_first,compliance\nA,B,y")).toThrow(/user_id column/);
  });

  it("detects the roster format on user_id alone", () => {
    expect(detectBackgroundCsvFormat("user_id,user_last,user_first\n1,A,B")).toBe("ROSTER");
    expect(detectBackgroundCsvFormat("First name,Last name,Email,Expiration date\nA,B,a@example.test,2029-01-01")).toBe("STERLING");
  });

  it("rejects a file over 5,000 rows", () => {
    const header = "user_id,user_last,user_first,roles,sites,user_active,compliance,issues";
    const rows = Array.from({ length: 5_001 }, (_, index) => `${index},Lee,Person${index},,,y,y,`);
    expect(() => parseRosterBackgroundCsv([header, ...rows].join("\n"))).toThrow(/too many rows/);
  });
});

describe("matchableName (#527)", () => {
  it("normalizes case, spacing, and accents", () => {
    expect(matchableName("José  O'Brien")).toBe(matchableName("jose obrien"));
    expect(matchableName("  Ana   Rivera ")).toBe(matchableName("ANA RIVERA"));
    expect(matchableName("Café")).toBe("cafe");
  });
});

describe("the unified list row mapping (#527)", () => {
  it("keeps a clear Sterling row dated, and reports a non-clear one as a problem instead of storing it (as before #527)", () => {
    const [clearRow] = parseSterlingCsv("First name,Last name,Email,Expiration date,Status\nAna,Rivera,ana@example.test,2029-01-01,Clear");
    expect(clearRow!.problems).toEqual([]);
    const clear = sterlingRowToListRow(clearRow!);
    expect(clear).toMatchObject({ complianceStatus: null, expiresOn: "2029-01-01", issuesNote: null });

    const [pendingRow] = parseSterlingCsv("First name,Last name,Email,Expiration date,Status\nBo,Lee,bo@example.test,2029-01-01,Pending adjudication");
    expect(pendingRow!.problems).toEqual(['Status is "Pending adjudication", not a clear check, so nothing was recorded. Review this person in Sterling.']);
  });

  it("builds a stable identity key: user_id first, then email, then birth date, then site, then name", () => {
    const normalizedName = matchableName("Ana Rivera");
    expect(backgroundCheckIdentityKey({ sourceUserId: "9001", normalizedName, email: "ana@example.test", birthDate: "1985-01-01", site: "Test Church" }))
      .toBe("userId:9001");
    expect(backgroundCheckIdentityKey({ sourceUserId: null, normalizedName, email: "ana@example.test", birthDate: "1985-01-01", site: "Test Church" }))
      .toBe(`email:ana@example.test|${normalizedName}`);
    expect(backgroundCheckIdentityKey({ sourceUserId: null, normalizedName, email: null, birthDate: "1985-01-01", site: "Test Church" }))
      .toBe(`name-birth:${normalizedName}|1985-01-01`);
    expect(backgroundCheckIdentityKey({ sourceUserId: null, normalizedName, email: null, birthDate: null, site: "Test Church" }))
      .toBe(`name-site:${normalizedName}|${matchableName("Test Church")}`);
  });

  it("gives the same person the same identity key from either CSV format when it has a user_id", () => {
    const [rosterRow] = parseRosterBackgroundCsv("user_id,user_last,user_first,compliance\n9001,Rivera,Ana,y");
    expect(rosterRowToListRow(rosterRow!).identityKey).toBe("userId:9001");
  });
});

describe("planBackgroundCheckUpload: the confirm counts (#527)", () => {
  beforeEach(() => { currentClient = makeFakeDb().client; });

  it("counts everything as added when the list is empty", async () => {
    const rows = [sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nAna,Rivera,ana@example.test,2029-01-01")[0]!)];
    await expect(planBackgroundCheckUpload(rows)).resolves.toMatchObject({ added: 1, changed: 0, dropped: 0, total: 1 });
  });

  it("counts added, changed, and dropped against what's already on file", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    const uploadId = "upload-1";
    seed.uploads.set(uploadId, { id: uploadId, createdAt: new Date("2026-09-01") });
    seed.entries.set("e-kept", { id: "e-kept", uploadId, identityKey: "email:ana@example.test|ana rivera", firstName: "Ana", lastName: "Rivera", email: "ana@example.test", sealedBirthDate: null, site: null, sourceUserId: null, complianceStatus: null, checkedOn: null, expiresOn: "2029-01-01", issuesNote: null });
    seed.entries.set("e-dropped", { id: "e-dropped", uploadId, identityKey: "email:bo@example.test|bo lee", firstName: "Bo", lastName: "Lee", email: "bo@example.test", sealedBirthDate: null, site: null, sourceUserId: null, complianceStatus: null, checkedOn: null, expiresOn: "2029-01-01", issuesNote: null });

    const rows = [
      sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nAna,Rivera,ana@example.test,2030-01-01")[0]!), // same identity, new date -> changed
      sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nKim,Cho,kim@example.test,2029-01-01")[0]!), // new -> added
    ];
    const counts = await planBackgroundCheckUpload(rows);
    expect(counts).toMatchObject({ added: 1, changed: 1, dropped: 1, total: 2 });
    expect(counts.fingerprint).toBe(backgroundCheckUploadFingerprint(uploadId, rows));
  });

  it("keeps the later row when an upload's own rows are the same person, and reports the earlier one instead of dropping it silently (B4)", async () => {
    const rows = parseSterlingCsv([
      "First name,Last name,Email,Expiration date",
      "Ana,Rivera,ana@example.test,2028-01-01",
      "Ana,Rivera,ana@example.test,2029-01-01",
    ].join("\n")).map(sterlingRowToListRow);
    const { rows: kept, duplicates } = dedupeListRows(rows);
    expect(kept.map((row) => [row.line, row.expiresOn])).toEqual([[3, "2029-01-01"]]);
    expect(duplicates).toEqual([{ line: 2, name: "Ana Rivera", problems: ["Row 3 is the same person, so only row 3 is kept."] }]);
    const counts = await planBackgroundCheckUpload(rows);
    expect(counts.total).toBe(1);
  });

  it("keeps a couple who share one email as two entries (B4)", async () => {
    const rows = parseSterlingCsv([
      "First name,Last name,Email,Expiration date",
      "Ana,Rivera,family@example.test,2029-01-01",
      "Luis,Rivera,family@example.test,2029-01-01",
    ].join("\n")).map(sterlingRowToListRow);
    expect(new Set(rows.map((row) => row.identityKey)).size).toBe(2);
    const { rows: kept, duplicates } = dedupeListRows(rows);
    expect(kept).toHaveLength(2);
    expect(duplicates).toEqual([]);
    await expect(planBackgroundCheckUpload(rows)).resolves.toMatchObject({ added: 2, total: 2 });
  });

  it("fingerprints the list a preview compared against and the rows it read (N1)", () => {
    const rows = [sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nAna,Rivera,ana@example.test,2029-01-01")[0]!)];
    const changedRows = [sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nAna,Rivera,ana@example.test,2030-01-01")[0]!)];
    expect(backgroundCheckUploadFingerprint("u-1", rows)).toBe(backgroundCheckUploadFingerprint("u-1", rows));
    expect(backgroundCheckUploadFingerprint("u-1", rows)).not.toBe(backgroundCheckUploadFingerprint("u-2", rows));
    expect(backgroundCheckUploadFingerprint("u-1", rows)).not.toBe(backgroundCheckUploadFingerprint("u-1", changedRows));
    expect(backgroundCheckUploadFingerprint("u-1", rows)).not.toContain("Rivera");
  });
});

describe("applyBackgroundCheckUpload: replace and match (#527)", () => {
  it("replaces the list wholesale: a person missing from the new file stops counting as checked", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    seed.persons.set("p-ana", { id: "p-ana", firstName: "Ana", lastName: "Rivera" });
    const rows1 = [sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nAna,Rivera,ana@example.test,2029-01-01")[0]!)];
    seed.persons.get("p-ana"); // no roster candidate, so this stays unmatched — fine, we're testing replacement, not matching
    await applyBackgroundCheckUpload(rows1, "STERLING", "admin-1");
    expect(seed.entries.size).toBe(1);

    // A second upload with a different person entirely: the first entry is gone.
    const rows2 = [sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nKim,Cho,kim@example.test,2029-01-01")[0]!)];
    await applyBackgroundCheckUpload(rows2, "STERLING", "admin-1");
    const remaining = [...seed.entries.values()];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ email: "kim@example.test" });
  });

  it("audits only counts, never names or dates", async () => {
    currentClient = makeFakeDb().client;
    const rows = [sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nAna,Rivera,ana@example.test,2029-01-01")[0]!)];
    await applyBackgroundCheckUpload(rows, "STERLING", "admin-1");
    expect(auditLog).toHaveBeenCalledTimes(1);
    const entry = auditLog.mock.calls[0]![0] as { action: string; metadata: Record<string, unknown> };
    expect(entry).toMatchObject({ action: "BACKGROUND_CHECK_LIST_UPLOADED", metadata: { format: "STERLING", rowCount: 1, added: 1, changed: 0, dropped: 0 } });
    expect(JSON.stringify(entry)).not.toContain("Rivera");
    expect(JSON.stringify(entry)).not.toContain("2029-01-01");
  });

  it("seals a birth date before storing it, never plain text", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    const rows = [sterlingRowToListRow(parseSterlingCsv("First name,Last name,Birth date,Expiration date\nAna,Rivera,1985-04-17,2029-01-01")[0]!)];
    await applyBackgroundCheckUpload(rows, "STERLING", "admin-1");
    const [entry] = [...seed.entries.values()];
    expect(entry!.sealedBirthDate).toBe("sealed:1985-04-17");
  });

  it("matches by name plus email, and keeps a zero-candidate row unmatched without a review", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    seed.persons.set("p-ana", { id: "p-ana", firstName: "Ana", lastName: "Rivera" });
    seed.rosterMembers.push({
      id: "rm-1", personId: "p-ana", organizationId: "org-1", clubYear: "2026-27", status: "ACTIVE", attendeeType: "ADULT", sealedBirthDate: null,
      person: { firstName: "Ana", lastName: "Rivera", normalizedEmail: "ana@example.test", attendeeAccountLinks: [] },
      organization: { name: "Test Pathfinders", parentOrganization: null },
    });
    const rows = [
      sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nAna,Rivera,ana@example.test,2029-01-01")[0]!),
      sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nPat,Nobody,pat@example.test,2029-01-01")[0]!),
    ];
    await applyBackgroundCheckUpload(rows, "STERLING", "admin-1", new Date("2026-09-28T12:00:00Z"));
    const matches = [...seed.matches.values()];
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ personId: "p-ana", matchedBy: "AUTO" });

    const unmatched = await listUnmatchedBackgroundCheckEntries();
    expect(unmatched.map((entry) => entry.firstName)).toEqual(["Pat"]);
  });

  it("sends an entry matching more than one person to review, and never guesses", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    for (const [id, email] of [["p-kim-1", "kim@example.test"], ["p-kim-2", "kim@example.test"]] as const) {
      seed.persons.set(id, { id, firstName: "Kim", lastName: "Cho" });
      seed.rosterMembers.push({
        id: `rm-${id}`, personId: id, organizationId: "org-1", clubYear: "2026-27", status: "ACTIVE", attendeeType: "ADULT", sealedBirthDate: null,
        person: { firstName: "Kim", lastName: "Cho", normalizedEmail: email, attendeeAccountLinks: [] },
        organization: { name: "Test Pathfinders", parentOrganization: null },
      });
    }
    const rows = [sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nKim,Cho,kim@example.test,2029-01-01")[0]!)];
    await applyBackgroundCheckUpload(rows, "STERLING", "admin-1", new Date("2026-09-28T12:00:00Z"));
    expect(seed.matches.size).toBe(0);
    const reviews = await listBackgroundCheckReviews();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.candidates.map((c) => c.personId).sort()).toEqual(["p-kim-1", "p-kim-2"]);
  });

  it("sends every entry that matches the same person to review, when more than one entry could match them", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    seed.persons.set("p-ana", { id: "p-ana", firstName: "Ana", lastName: "Rivera" });
    seed.rosterMembers.push({
      id: "rm-1", personId: "p-ana", organizationId: "org-1", clubYear: "2026-27", status: "ACTIVE", attendeeType: "ADULT", sealedBirthDate: "sealed:1985-04-17",
      person: { firstName: "Ana", lastName: "Rivera", normalizedEmail: "ana@example.test", attendeeAccountLinks: [{ account: { email: "ana.alt@example.test" } }] },
      organization: { name: "Test Pathfinders", parentOrganization: null },
    });
    const rows = [
      sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nAna,Rivera,ana@example.test,2029-01-01")[0]!),
      sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nAna,Rivera,ana.alt@example.test,2028-01-01")[0]!),
    ];
    await applyBackgroundCheckUpload(rows, "STERLING", "admin-1", new Date("2026-09-28T12:00:00Z"));
    expect(seed.matches.size).toBe(0);
    const reviews = await listBackgroundCheckReviews();
    expect(reviews).toHaveLength(2);
    expect(reviews.every((review) => review.candidates.map((c) => c.personId)[0] === "p-ana")).toBe(true);
  });

  it("uses a remembered user_id first, but only when the name agrees", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    seed.persons.set("p-lu", { id: "p-lu", firstName: "Lu", lastName: "Moss" });
    seed.identities.set("id-1", { id: "id-1", provider: "ROSTER_IMPORT", providerScope: "", externalId: "userId:9001", personId: "p-lu" });
    const [row] = parseRosterBackgroundCsv("user_id,user_last,user_first,compliance\n9001,Moss,Lu,y");
    await applyBackgroundCheckUpload([rosterRowToListRow(row!)], "ROSTER", "admin-1", new Date("2026-09-28T12:00:00Z"));
    const matches = [...seed.matches.values()];
    expect(matches).toEqual([expect.objectContaining({ personId: "p-lu", matchedBy: "IDENTITY" })]);
  });

  it("sends a remembered user_id whose name doesn't match to review, naming who it belongs to", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    seed.persons.set("p-lu", { id: "p-lu", firstName: "Lu", lastName: "Moss" });
    seed.identities.set("id-1", { id: "id-1", provider: "ROSTER_IMPORT", providerScope: "", externalId: "userId:9001", personId: "p-lu" });
    const [row] = parseRosterBackgroundCsv("user_id,user_last,user_first,compliance\n9001,Rivera,Ana,y");
    await applyBackgroundCheckUpload([rosterRowToListRow(row!)], "ROSTER", "admin-1", new Date("2026-09-28T12:00:00Z"));
    expect(seed.matches.size).toBe(0);
    const reviews = await listBackgroundCheckReviews();
    expect(reviews[0]!.reason).toContain("Lu Moss");
    expect(reviews[0]!.candidates).toEqual([{ personId: "p-lu", name: "Lu Moss", sites: [] }]);
  });
});

function rosterAdult(seed: ReturnType<typeof makeFakeDb>["seed"], personId: string, firstName: string, lastName: string, extra: { email?: string; clubName?: string; parentName?: string; clubYear?: string; sealedBirthDate?: string | null; attendeeType?: string } = {}) {
  seed.persons.set(personId, { id: personId, firstName, lastName, normalizedEmail: extra.email ?? null });
  seed.rosterMembers.push({
    id: `rm-${personId}`, personId, organizationId: "org-1", clubYear: extra.clubYear ?? "2026-27", status: "ACTIVE", attendeeType: extra.attendeeType ?? "ADULT", sealedBirthDate: extra.sealedBirthDate ?? null,
    person: { firstName, lastName, normalizedEmail: extra.email ?? null, attendeeAccountLinks: [] },
    organization: { name: extra.clubName ?? "Test Pathfinders", parentOrganization: extra.parentName ? { name: extra.parentName } : null },
  });
}

function seedEntry(seed: ReturnType<typeof makeFakeDb>["seed"], id: string, fields: Row) {
  seed.entries.set(id, {
    id, uploadId: "u-1", identityKey: `migrated:${id}`, firstName: "", lastName: "", normalizedName: null, email: null, sealedBirthDate: null,
    site: null, sourceUserId: null, complianceStatus: null, checkedOn: null, expiresOn: null, issuesNote: null, ...fields,
  });
}

describe("refreshBackgroundCheckMatchForPerson: matched without a re-upload (#527)", () => {
  it("a person added to a roster after an upload is matched right away", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    // The upload happens first, with no one on file yet to match "Ana Rivera" to.
    const rows = [sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nAna,Rivera,ana@example.test,2029-01-01")[0]!)];
    await applyBackgroundCheckUpload(rows, "STERLING", "admin-1", new Date("2026-09-28T12:00:00Z"));
    expect(seed.matches.size).toBe(0);

    // Ana is added to a club roster afterward.
    rosterAdult(seed, "p-ana", "Ana", "Rivera", { email: "ana@example.test" });
    await refreshBackgroundCheckMatchForPerson("p-ana", new Date("2026-09-29T12:00:00Z"));

    const matches = [...seed.matches.values()];
    expect(matches).toEqual([expect.objectContaining({ personId: "p-ana", matchedBy: "AUTO" })]);
  });

  it("clears a stale match when a person's name change no longer matches their old entry", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    seed.uploads.set("u-1", { id: "u-1", createdAt: new Date("2026-09-01") });
    seed.persons.set("p-ana", { id: "p-ana", firstName: "Ana", lastName: "Rivera" });
    seedEntry(seed, "e-1", { identityKey: "email:ana@example.test|ana rivera", firstName: "Ana", lastName: "Rivera", normalizedName: matchableName("Ana Rivera"), email: "ana@example.test", expiresOn: "2029-01-01" });
    seed.matches.set("m-1", { id: "m-1", personId: "p-ana", entryId: "e-1", matchedBy: "AUTO", createdAt: new Date(), updatedAt: new Date() });

    // Renamed — no roster/registration candidate any more under the new name, and no entry shares it either.
    seed.persons.set("p-ana", { id: "p-ana", firstName: "Anna", lastName: "Riveraz" });
    await refreshBackgroundCheckMatchForPerson("p-ana", new Date("2026-09-29T12:00:00Z"));
    expect(seed.matches.size).toBe(0);
  });

  it("never deletes a MIGRATED or MANUAL match it can't recreate (B1)", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    seed.uploads.set("u-1", { id: "u-1", createdAt: new Date("2026-09-01") });
    // Two people sharing a name: one carried over by the migration (no
    // evidence at all on the entry), one matched by hand.
    rosterAdult(seed, "p-kim-1", "Kim", "Cho");
    rosterAdult(seed, "p-kim-2", "Kim", "Cho");
    seedEntry(seed, "e-migrated", { firstName: "Kim", lastName: "Cho", normalizedName: matchableName("Kim Cho"), complianceStatus: "CLEAR" });
    seedEntry(seed, "e-manual", { identityKey: "name:kim cho", firstName: "Kim", lastName: "Cho", normalizedName: matchableName("Kim Cho"), complianceStatus: "FLAGGED" });
    seed.matches.set("m-1", { id: "m-1", personId: "p-kim-1", entryId: "e-migrated", matchedBy: "MIGRATED", createdAt: new Date(), updatedAt: new Date() });
    seed.matches.set("m-2", { id: "m-2", personId: "p-kim-2", entryId: "e-manual", matchedBy: "MANUAL", createdAt: new Date(), updatedAt: new Date() });

    await refreshBackgroundCheckMatchForPerson("p-kim-1", new Date("2026-09-29T12:00:00Z"));
    await refreshBackgroundCheckMatchForPerson("p-kim-2", new Date("2026-09-29T12:00:00Z"));

    expect([...seed.matches.values()].map((match) => [match.personId, match.entryId, match.matchedBy]).sort()).toEqual([
      ["p-kim-1", "e-migrated", "MIGRATED"],
      ["p-kim-2", "e-manual", "MANUAL"],
    ]);
    expect(seed.reviews.size).toBe(0);
  });

  it("fills in a migrated entry's normalizedName in TypeScript, accents and hyphens included (B3)", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    seed.uploads.set("u-1", { id: "u-1", createdAt: new Date("2026-09-01") });
    seed.persons.set("p-jose", { id: "p-jose", firstName: "José", lastName: "Núñez" });
    seedEntry(seed, "e-jose", { firstName: "José", lastName: "Núñez" });
    seedEntry(seed, "e-mary", { firstName: "Mary-Ann", lastName: "Smith - Jones" });
    await refreshBackgroundCheckMatchForPerson("p-jose", new Date("2026-09-29T12:00:00Z"));
    expect(seed.entries.get("e-jose")!.normalizedName).toBe("jose nunez");
    expect(seed.entries.get("e-jose")!.normalizedName).toBe(matchableName("Jose Nunez"));
    expect(seed.entries.get("e-mary")!.normalizedName).toBe(matchableName("Mary-Ann Smith - Jones"));
  });

  it("groups the refresh by matchableName, the same as the full pass, not exact first and last names (N6)", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    // The list says "Jose Nunez" (no accents); the roster says "José Núñez".
    const rows = [sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nJose,Nunez,jose@example.test,2029-01-01")[0]!)];
    await applyBackgroundCheckUpload(rows, "STERLING", "admin-1", new Date("2026-09-28T12:00:00Z"));
    rosterAdult(seed, "p-jose", "José", "Núñez", { email: "jose@example.test" });
    await refreshBackgroundCheckMatchForPerson("p-jose", new Date("2026-09-29T12:00:00Z"));
    expect([...seed.matches.values()]).toEqual([expect.objectContaining({ personId: "p-jose", matchedBy: "AUTO" })]);
  });

  it("is skipped, not waited on, while an upload holds the list", async () => {
    const { client, seed, lock } = makeFakeDb();
    currentClient = client;
    const rows = [sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nAna,Rivera,ana@example.test,2029-01-01")[0]!)];
    await applyBackgroundCheckUpload(rows, "STERLING", "admin-1", new Date("2026-09-28T12:00:00Z"));
    rosterAdult(seed, "p-ana", "Ana", "Rivera", { email: "ana@example.test" });
    lock.held = true;
    await expect(refreshBackgroundCheckMatchForPerson("p-ana", new Date("2026-09-29T12:00:00Z"))).resolves.toBeUndefined();
    expect(seed.matches.size).toBe(0);
    lock.held = false;
    await refreshBackgroundCheckMatchForPerson("p-ana", new Date("2026-09-29T12:00:00Z"));
    expect(seed.matches.size).toBe(1);
  });

  it("does nothing, and fails nothing, before any list has been uploaded", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    rosterAdult(seed, "p-ana", "Ana", "Rivera");
    await expect(refreshBackgroundCheckMatchForPerson("p-ana")).resolves.toBeUndefined();
    expect(seed.matches.size).toBe(0);
  });
});

describe("site matching against the real export's shapes (#572)", () => {
  it("strips a location suffix and the church, club, and denomination words", () => {
    expect(matchesSite("Maple Grove SDA Church (Springfield)", ["Maple Grove SDA Church"])).toBe(true);
    expect(matchesSite("Maple Grove SDA Church (Springfield)", ["Maple Grove Pathfinders"])).toBe(true);
    expect(matchesSite("Maple Grove Seventh-day Adventist Church", ["Maple Grove SDA Church"])).toBe(true);
    expect(matchesSite("Maple Grove SDA Church", ["Cedar Hill SDA Church"])).toBe(false);
  });

  it("matches when any one site in a comma-separated cell matches", () => {
    expect(matchesSite("Maple Grove SDA Church (Springfield),Lakeside Adventist School", ["Maple Grove SDA Church"])).toBe(true);
    expect(matchesSite("Maple Grove SDA Church (Springfield),Lakeside Adventist School", ["Lakeside Adventist School"])).toBe(true);
    expect(siteStems("Nevada (IA) SDA Church, Other Place")).toEqual(new Set(["nevada ia", "other place"]));
  });

  it("ignores case, so ALL-CAPS names match", () => {
    expect(matchesSite("MAPLE GROVE SDA CHURCH (SPRINGFIELD)", ["Maple Grove SDA Church"])).toBe(true);
    expect(matchesSite("maple grove sda church", ["MAPLE GROVE PATHFINDERS"])).toBe(true);
  });

  it("does not match a school to a church unless the stems are equal", () => {
    expect(matchesSite("Maple Grove Adventist School", ["Maple Grove SDA Church"])).toBe(false);
    expect(matchesSite("Maple Grove SDA Church", ["Maple Grove Adventist School"])).toBe(false);
    expect(matchesSite("Maple Grove Adventist School", ["Maple Grove Adventist School"])).toBe(true);
  });

  it("matches a directory name with its own parenthetical, with or without it", () => {
    expect(matchesSite("Reedville (IA) SDA Church", ["Reedville (IA) SDA Church"])).toBe(true);
    expect(matchesSite("Reedville (IA) SDA Church (Reedville)", ["Reedville (IA) SDA Church"])).toBe(true);
    expect(matchesSite("Reedville SDA Church", ["Reedville (IA) SDA Church"])).toBe(false);
  });

  it("never treats two different parentheticals as the same church (MO vs IA)", () => {
    expect(matchesSite("Nevada (MO) SDA Church", ["Nevada (IA) SDA Church"])).toBe(false);
    expect(matchesSite("Nevada (MO) SDA Church (Nevada)", ["Nevada (IA) SDA Church"])).toBe(false);
    expect(matchesSite("Nevada (IA) SDA Church (Nevada)", ["Nevada (IA) SDA Church"])).toBe(true);
  });

  it("reads only one trailing parenthetical as the export's city suffix", () => {
    expect(siteStems("Kansas City SDA Church (Central)")).toEqual(new Set(["kansas city central", "kansas city"]));
    // With no "Kansas City (Central)" church in the directory, the suffix-stripped key is the fallback.
    expect(matchesSite("Kansas City SDA Church (Central)", ["Kansas City SDA Church"])).toBe(true);
    expect(matchesSite("Kansas City SDA Church (Central)", ["Kansas City SDA Church"], directorySiteStems(["Kansas City SDA Church"]))).toBe(true);
    expect(matchesSite("Kansas City SDA Church", ["Kansas City SDA Church (Central)"])).toBe(false);
    expect(siteStems("Nevada (IA) SDA Church (Nevada)")).toEqual(new Set(["nevada ia nevada", "nevada ia"]));
  });

  it("uses the suffix-stripped key only when the full stem is no directory site", () => {
    const directory = directorySiteStems(["Kansas City SDA Church", "Kansas City (Central) SDA Church"]);
    // A church literally named "Kansas City (Central)" exists: the row is that church, not plain Kansas City.
    expect(siteStems("Kansas City (Central)", directory)).toEqual(new Set(["kansas city central"]));
    expect(matchesSite("Kansas City (Central)", ["Kansas City SDA Church"], directory)).toBe(false);
    expect(matchesSite("Kansas City (Central)", ["Kansas City (Central) SDA Church"], directory)).toBe(true);
    // No such church in the directory: the fallback applies.
    const plainOnly = directorySiteStems(["Kansas City SDA Church"]);
    expect(matchesSite("Kansas City (Central)", ["Kansas City SDA Church"], plainOnly)).toBe(true);
    expect(siteStems("Kansas City (Central)", plainOnly)).toEqual(new Set(["kansas city central", "kansas city"]));
  });

  it("also reads a merged state code's site without it, as a row key only", () => {
    expect(siteStems("Springfield, MO SDA Church")).toEqual(new Set(["springfield mo", "springfield"]));
    expect(siteStems("Springfield SDA Church, MO")).toEqual(new Set(["springfield mo", "springfield"]));
    expect(matchesSite("Springfield, MO SDA Church", ["Springfield SDA Church"])).toBe(true);
    expect(matchesSite("Springfield SDA Church", ["Springfield, MO SDA Church"])).toBe(false);
    // A directory church that is exactly "Springfield, MO" keeps the row on it.
    expect(matchesSite("Springfield, MO SDA Church", ["Springfield SDA Church"], directorySiteStems(["Springfield, MO SDA Church"]))).toBe(false);
  });

  it("never splits a directory name", () => {
    expect(candidateSiteStems("Maple, Oak SDA Church")).toEqual(new Set(["maple oak"]));
    expect(matchesSite("Maple SDA Church", ["Maple, Oak SDA Church"])).toBe(false);
    expect(matchesSite("Oak SDA Church", ["Maple, Oak SDA Church"])).toBe(false);
  });

  it("drops short and generic stems so they never match", () => {
    expect(siteStems("SDA Church")).toEqual(new Set());
    expect(siteStems("First SDA Church")).toEqual(new Set());
    expect(siteStems("Central Church, MO, Ab")).toEqual(new Set());
    expect(siteStems("Seventh-day Adventist Church")).toEqual(new Set());
    expect(matchesSite("First SDA Church", ["First SDA Church"])).toBe(false);
    expect(matchesSite("Ab Church", ["Ab Church"])).toBe(false);
    expect(matchesSite("SDA Church (Springfield)", ["Springfield SDA Church"])).toBe(true);
    expect(siteStems("SDA Church (Springfield)")).toEqual(new Set(["springfield"]));
  });

  it("does not split on a comma before a state code", () => {
    expect(siteStems("Springfield SDA Church, Lakeside Adventist School")).toEqual(new Set(["springfield", "lakeside adventist school"]));
  });

  it("handles nested and unbalanced parentheses", () => {
    expect(siteStems("Lake (North (Old)) SDA Church (Lake (Town))")).toEqual(new Set(["lake north old lake town", "lake north old"]));
    expect(siteStems("Elm SDA Church (Elm,Oak SDA Church")).toEqual(new Set(["elm elm", "oak"]));
    expect(siteStems("Pine SDA Church),Ash SDA Church")).toEqual(new Set(["pine", "ash"]));
  });

  it("returns false for an empty or noise-only site", () => {
    expect(matchesSite("", ["Maple Grove SDA Church"])).toBe(false);
    expect(matchesSite("SDA Church", ["Church"])).toBe(false);
  });
});

describe("site matching through the upload and refresh path (#572)", () => {
  const now = new Date("2026-09-29T12:00:00Z");
  function rosterRow(userId: string, last: string, first: string, sites: string) {
    const csv = `user_id,user_last,user_first,sites,compliance\n${userId},${last},${first},"${sites}",y`;
    return rosterRowToListRow(parseRosterBackgroundCsv(csv)[0]!);
  }
  function secondLee(seed: ReturnType<typeof makeFakeDb>["seed"]) {
    seed.persons.set("p-lee-2", { id: "p-lee-2", firstName: "Lee", lastName: "Park" });
    seed.rosterMembers.push({
      id: "rm-p-lee-2", personId: "p-lee-2", organizationId: "org-2", clubYear: "2026-27", status: "ACTIVE", attendeeType: "ADULT", sealedBirthDate: null,
      person: { firstName: "Lee", lastName: "Park", normalizedEmail: null, attendeeAccountLinks: [] },
      organization: { name: "Cedar Hill Pathfinders", parentOrganization: { name: "Cedar Hill SDA Church" } },
    });
  }

  it("re-matches stored entries under the new rule with no new upload", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    seed.uploads.set("u-1", { id: "u-1", createdAt: new Date("2026-09-01") });
    // Stored earlier, when a suffixed site never matched.
    seedEntry(seed, "e-1", {
      identityKey: "user:7001", sourceUserId: "7001", firstName: "Mina", lastName: "Osei", normalizedName: matchableName("Mina Osei"),
      site: "Maple Grove SDA Church (Springfield),Lakeside Adventist School", complianceStatus: "CLEAR",
    });
    rosterAdult(seed, "p-mina", "Mina", "Osei", { clubName: "Maple Grove Pathfinders", parentName: "Maple Grove SDA Church" });
    expect(seed.matches.size).toBe(0);
    await refreshBackgroundCheckMatchForPerson("p-mina", now);
    expect([...seed.matches.values()]).toEqual([expect.objectContaining({ personId: "p-mina", entryId: "e-1", matchedBy: "AUTO" })]);
  });

  it("keeps two same-name people at different churches separate", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    rosterAdult(seed, "p-lee-1", "Lee", "Park", { clubName: "Maple Grove Pathfinders", parentName: "Maple Grove SDA Church" });
    secondLee(seed);
    await applyBackgroundCheckUpload([rosterRow("8001", "Park", "Lee", "CEDAR HILL SDA CHURCH (Riverton)")], "ROSTER", "admin-1", now);
    expect([...seed.matches.values()].map((match) => match.personId)).toEqual(["p-lee-2"]);
    expect(seed.reviews.size).toBe(0);
  });

  it("goes to review, matching neither, when one cell names both people's churches", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    rosterAdult(seed, "p-lee-1", "Lee", "Park", { clubName: "Maple Grove Pathfinders", parentName: "Maple Grove SDA Church" });
    secondLee(seed);
    await applyBackgroundCheckUpload([rosterRow("8002", "Park", "Lee", "Maple Grove SDA Church (Springfield),Cedar Hill SDA Church (Riverton)")], "ROSTER", "admin-1", now);
    expect(seed.matches.size).toBe(0);
    expect(seed.reviews.size).toBe(1);
  });

  it("matches an adult on the previous club year's roster while today is in 2026-27, and merges one person's two years", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    rosterAdult(seed, "p-ivo", "Ivo", "Brandt", { clubName: "Old Mill Pathfinders", parentName: "Old Mill SDA Church", clubYear: "2025-26" });
    // Two years ago is outside the pool.
    rosterAdult(seed, "p-ola", "Ola", "Brandt", { clubName: "Old Mill Pathfinders", clubYear: "2024-25" });
    await applyBackgroundCheckUpload([
      rosterRow("9001", "Brandt", "Ivo", "Old Mill SDA Church (Millton)"),
      rosterRow("9002", "Brandt", "Ola", "Old Mill SDA Church (Millton)"),
    ], "ROSTER", "admin-1", now);
    expect([...seed.matches.values()].map((match) => match.personId)).toEqual(["p-ivo"]);

    // The same person on both years is one candidate, not an ambiguity.
    seed.rosterMembers.push({
      id: "rm-p-ivo-2", personId: "p-ivo", organizationId: "org-1", clubYear: "2026-27", status: "ACTIVE", attendeeType: "ADULT", sealedBirthDate: null,
      person: { firstName: "Ivo", lastName: "Brandt", normalizedEmail: null, attendeeAccountLinks: [] },
      organization: { name: "Old Mill Pathfinders", parentOrganization: { name: "Old Mill SDA Church" } },
    });
    await applyBackgroundCheckUpload([rosterRow("9001", "Brandt", "Ivo", "Old Mill SDA Church (Millton)")], "ROSTER", "admin-1", now);
    expect([...seed.matches.values()].map((match) => match.personId)).toEqual(["p-ivo"]);
    expect(seed.reviews.size).toBe(0);
  });
});

describe("remembered user_ids (#527 B2, N3)", () => {
  it("records the user_id identity on a confident name-and-site match, as the roster import did", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    rosterAdult(seed, "p-lu", "Lu", "Moss", { clubName: "Test Pathfinders" });
    const [row] = parseRosterBackgroundCsv("user_id,user_last,user_first,sites,compliance\n9001,Moss,Lu,Test Pathfinders,y");
    await applyBackgroundCheckUpload([rosterRowToListRow(row!)], "ROSTER", "admin-1", new Date("2026-09-28T12:00:00Z"));
    expect([...seed.matches.values()]).toEqual([expect.objectContaining({ personId: "p-lu", matchedBy: "AUTO" })]);
    expect([...seed.identities.values()]).toEqual([expect.objectContaining({ provider: "ROSTER_IMPORT", providerScope: "", externalId: "userId:9001", personId: "p-lu" })]);

    // The next upload matches by that identity, even with the site gone.
    const [again] = parseRosterBackgroundCsv("user_id,user_last,user_first,compliance\n9001,Moss,Lu,n");
    await applyBackgroundCheckUpload([rosterRowToListRow(again!)], "ROSTER", "admin-1", new Date("2026-10-01T12:00:00Z"));
    expect([...seed.matches.values()]).toEqual([expect.objectContaining({ personId: "p-lu", matchedBy: "IDENTITY" })]);
  });

  it("never overwrites a user_id that belongs to someone else, or a person's other remembered id", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    rosterAdult(seed, "p-lu", "Lu", "Moss", { clubName: "Test Pathfinders" });
    seed.identities.set("id-1", { id: "id-1", provider: "ROSTER_IMPORT", providerScope: "", externalId: "userId:7777", personId: "p-lu" });
    const [row] = parseRosterBackgroundCsv("user_id,user_last,user_first,sites,compliance\n9001,Moss,Lu,Test Pathfinders,y");
    await applyBackgroundCheckUpload([rosterRowToListRow(row!)], "ROSTER", "admin-1", new Date("2026-09-28T12:00:00Z"));
    expect([...seed.identities.values()]).toEqual([expect.objectContaining({ externalId: "userId:7777", personId: "p-lu" })]);
  });

  it("only a provider user_id is ever remembered as an identity (N3)", () => {
    expect(isRememberedIdentityKey("userId:9001")).toBe(true);
    for (const key of ["name:ana rivera", "name-site:ana rivera|test church", "email:ana@example.test|ana rivera", "name-birth:ana rivera|1985-01-01", "migrated:x", "userId:"]) {
      expect(isRememberedIdentityKey(key)).toBe(false);
    }
  });
});

describe("staff review resolution (#527)", () => {
  function ambiguousKimCho(seed: ReturnType<typeof makeFakeDb>["seed"], identityKey = "email:kim@example.test|kim cho") {
    seed.persons.set("p-kim-1", { id: "p-kim-1", firstName: "Kim", lastName: "Cho" });
    seed.persons.set("p-kim-2", { id: "p-kim-2", firstName: "Kim", lastName: "Cho" });
    seed.uploads.set("u-1", { id: "u-1", createdAt: new Date("2026-09-01") });
    seedEntry(seed, "e-1", { identityKey, firstName: "Kim", lastName: "Cho", normalizedName: matchableName("Kim Cho"), email: "kim@example.test", expiresOn: "2029-01-01" });
    seed.reviews.set("r-1", { id: "r-1", entryId: "e-1", reason: "More than one person matches.", candidatePersonIds: ["p-kim-1", "p-kim-2"], createdAt: new Date() });
  }

  it("keeps a manual match across refreshes and the next upload, without an identity for a non-user_id key (N2, N3)", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    ambiguousKimCho(seed);

    await resolveBackgroundCheckReview("r-1", { type: "match", personId: "p-kim-1" }, "admin-1");

    expect(seed.reviews.size).toBe(0);
    expect([...seed.matches.values()]).toEqual([expect.objectContaining({ personId: "p-kim-1", entryId: "e-1", matchedBy: "MANUAL" })]);
    expect(seed.identities.size).toBe(0);

    await refreshBackgroundCheckMatchForPerson("p-kim-1", new Date("2026-09-29T12:00:00Z"));
    expect([...seed.matches.values()]).toEqual([expect.objectContaining({ personId: "p-kim-1", matchedBy: "MANUAL" })]);

    // The next upload's row with the same identity key keeps the staff decision.
    const rows = [sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nKim,Cho,kim@example.test,2030-01-01")[0]!)];
    await applyBackgroundCheckUpload(rows, "STERLING", "admin-1", new Date("2026-10-01T12:00:00Z"));
    const finalMatches = [...seed.matches.values()];
    expect(finalMatches).toEqual([expect.objectContaining({ personId: "p-kim-1", matchedBy: "MANUAL" })]);
    expect(seed.entries.get(finalMatches[0]!.entryId as string)).toMatchObject({ expiresOn: "2030-01-01" });
  });

  it("holds a manual match on a user_id row even when the next upload's name differs (N2)", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    ambiguousKimCho(seed, "userId:42");
    await resolveBackgroundCheckReview("r-1", { type: "match", personId: "p-kim-2" }, "admin-1");
    expect([...seed.identities.values()]).toEqual([expect.objectContaining({ externalId: "userId:42", personId: "p-kim-2" })]);

    const [row] = parseRosterBackgroundCsv("user_id,user_last,user_first,compliance\n42,Cho-Park,Kimberly,y");
    await applyBackgroundCheckUpload([rosterRowToListRow(row!)], "ROSTER", "admin-1", new Date("2026-10-01T12:00:00Z"));
    expect([...seed.matches.values()]).toEqual([expect.objectContaining({ personId: "p-kim-2", matchedBy: "MANUAL" })]);
    expect(seed.reviews.size).toBe(0);
  });

  it("undoes a manual match: the match and its user_id identity go, and the automatic rules apply again", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    ambiguousKimCho(seed, "userId:42");
    await resolveBackgroundCheckReview("r-1", { type: "match", personId: "p-kim-1" }, "admin-1");
    const [manual] = await listManualBackgroundCheckMatches();
    expect(manual).toMatchObject({ personId: "p-kim-1", personName: "Kim Cho", entryName: "Kim Cho" });

    await undoManualBackgroundCheckMatch(manual!.id, "admin-1");
    expect(seed.matches.size).toBe(0);
    expect(seed.identities.size).toBe(0);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "BACKGROUND_CHECK_MANUAL_MATCH_UNDONE" }), client);
    await expect(listManualBackgroundCheckMatches()).resolves.toEqual([]);
  });

  it("refuses to undo a match that wasn't made by hand, or one that's gone", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    seed.uploads.set("u-1", { id: "u-1", createdAt: new Date("2026-09-01") });
    seed.persons.set("p-ana", { id: "p-ana", firstName: "Ana", lastName: "Rivera" });
    seedEntry(seed, "e-1", { firstName: "Ana", lastName: "Rivera", normalizedName: "ana rivera" });
    seed.matches.set("m-1", { id: "m-1", personId: "p-ana", entryId: "e-1", matchedBy: "AUTO", createdAt: new Date(), updatedAt: new Date() });
    await expect(undoManualBackgroundCheckMatch("m-1", "admin-1")).rejects.toMatchObject({ code: "NOT_A_MANUAL_MATCH", status: 400 });
    await expect(undoManualBackgroundCheckMatch("m-missing", "admin-1")).rejects.toMatchObject({ code: "MATCH_NOT_FOUND", status: 404 });
    expect(seed.matches.size).toBe(1);
  });

  it("keeps a dismissal: the entry matches no one on a refresh, isn't reviewed again, and shows as unmatched", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    seed.uploads.set("u-1", { id: "u-1", createdAt: new Date("2026-09-01") });
    rosterAdult(seed, "p-kim-1", "Kim", "Cho", { email: "kim@example.test" });
    rosterAdult(seed, "p-kim-2", "Kim", "Cho", { email: "kim@example.test" });
    seedEntry(seed, "e-1", { identityKey: "email:kim@example.test|kim cho", firstName: "Kim", lastName: "Cho", normalizedName: matchableName("Kim Cho"), email: "kim@example.test" });
    seed.reviews.set("r-1", { id: "r-1", entryId: "e-1", reason: "Ambiguous.", candidatePersonIds: ["p-kim-1", "p-kim-2"], dismissedAt: null, createdAt: new Date() });
    await resolveBackgroundCheckReview("r-1", { type: "dismiss" }, "admin-1");
    expect(seed.reviews.get("r-1")!.dismissedAt).toBeInstanceOf(Date);
    expect(seed.matches.size).toBe(0);
    expect(seed.identities.size).toBe(0);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "BACKGROUND_CHECK_REVIEW_DISMISSED" }), client);
    await expect(listBackgroundCheckReviews()).resolves.toEqual([]);

    // One of them leaves the other club: a refresh would now find a single candidate, but staff said no.
    seed.rosterMembers.splice(seed.rosterMembers.findIndex((member) => member.personId === "p-kim-2"), 1);
    await refreshBackgroundCheckMatchForPerson("p-kim-1", new Date("2026-09-29T12:00:00Z"));
    expect(seed.matches.size).toBe(0);
    expect([...seed.reviews.values()]).toEqual([expect.objectContaining({ id: "r-1", dismissedAt: expect.any(Date) })]);
    expect((await listUnmatchedBackgroundCheckEntries()).map((entry) => entry.id)).toEqual(["e-1"]);
    await expect(resolveBackgroundCheckReview("r-1", { type: "match", personId: "p-kim-1" }, "admin-1")).rejects.toMatchObject({ code: "REVIEW_NOT_FOUND" });
  });

  it("dismissing one of two rows that match one person keeps the other row's review open, and never auto-matches them", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    seed.persons.set("p-ana", { id: "p-ana", firstName: "Ana", lastName: "Rivera", normalizedEmail: "ana@example.test" });
    seed.rosterMembers.push({
      id: "rm-ana", personId: "p-ana", organizationId: "org-1", clubYear: "2026-27", status: "ACTIVE", attendeeType: "ADULT", sealedBirthDate: null,
      person: { firstName: "Ana", lastName: "Rivera", normalizedEmail: "ana@example.test", attendeeAccountLinks: [{ account: { email: "ana.alt@example.test" } }] },
      organization: { name: "Test Pathfinders", parentOrganization: null },
    });
    const rows = parseSterlingCsv([
      "First name,Last name,Email,Expiration date",
      "Ana,Rivera,ana@example.test,2029-01-01",
      "Ana,Rivera,ana.alt@example.test,2028-01-01",
    ].join("\n")).map(sterlingRowToListRow);
    await applyBackgroundCheckUpload(rows, "STERLING", "admin-1", new Date("2026-09-28T12:00:00Z"));
    const [first, second] = await listBackgroundCheckReviews();
    expect(first && second).toBeTruthy();

    await resolveBackgroundCheckReview(first!.id, { type: "dismiss" }, "admin-1");
    await refreshBackgroundCheckMatchForPerson("p-ana", new Date("2026-09-29T12:00:00Z"));

    expect(seed.matches.size).toBe(0);
    const open = await listBackgroundCheckReviews();
    expect(open.map((review) => review.id)).toEqual([second!.id]);
    expect(open[0]!.candidates.map((candidate) => candidate.personId)).toEqual(["p-ana"]);

    // Staff can still decide the open one.
    await resolveBackgroundCheckReview(second!.id, { type: "match", personId: "p-ana" }, "admin-1");
    expect([...seed.matches.values()]).toEqual([expect.objectContaining({ personId: "p-ana", entryId: second!.entryId, matchedBy: "MANUAL" })]);
  });

  it("answers 409 when a staff match or undo collides with a concurrent change (P2002)", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    ambiguousKimCho(seed);
    const clash = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    const create = client.backgroundCheckMatch.create;
    client.backgroundCheckMatch.create = async () => { throw clash; };
    await expect(resolveBackgroundCheckReview("r-1", { type: "match", personId: "p-kim-1" }, "admin-1")).rejects.toMatchObject({ code: "LIST_CHANGED", status: 409 });
    client.backgroundCheckMatch.create = create;

    await resolveBackgroundCheckReview("r-1", { type: "match", personId: "p-kim-1" }, "admin-1");
    const [manual] = await listManualBackgroundCheckMatches();
    const deleteMany = client.backgroundCheckMatch.deleteMany;
    client.backgroundCheckMatch.deleteMany = async () => { throw clash; };
    await expect(undoManualBackgroundCheckMatch(manual!.id, "admin-1")).rejects.toMatchObject({ code: "LIST_CHANGED", status: 409 });
    client.backgroundCheckMatch.deleteMany = deleteMany;
  });

  it("never creates a second review for the same entry (N2)", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    rosterAdult(seed, "p-kim-1", "Kim", "Cho", { email: "kim@example.test" });
    rosterAdult(seed, "p-kim-2", "Kim", "Cho", { email: "kim@example.test" });
    const rows = [sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nKim,Cho,kim@example.test,2029-01-01")[0]!)];
    await applyBackgroundCheckUpload(rows, "STERLING", "admin-1", new Date("2026-09-28T12:00:00Z"));
    await refreshBackgroundCheckMatchForPerson("p-kim-1", new Date("2026-09-29T12:00:00Z"));
    await refreshBackgroundCheckMatchForPerson("p-kim-2", new Date("2026-09-29T12:00:00Z"));
    expect(seed.reviews.size).toBe(1);
  });

  it("refuses a review decision or an undo while an upload holds the list, with a 409 (N1)", async () => {
    const { client, seed, lock } = makeFakeDb();
    currentClient = client;
    ambiguousKimCho(seed);
    lock.held = true;
    await expect(resolveBackgroundCheckReview("r-1", { type: "match", personId: "p-kim-1" }, "admin-1")).rejects.toMatchObject({ code: "UPLOAD_IN_PROGRESS", status: 409 });
    await expect(undoManualBackgroundCheckMatch("m-any", "admin-1")).rejects.toMatchObject({ code: "UPLOAD_IN_PROGRESS", status: 409 });
    expect(seed.matches.size).toBe(0);
    expect(seed.reviews.size).toBe(1);
  });

  it("is a 400 to pick someone who isn't a candidate, and a 404 for an unknown review (N5)", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    ambiguousKimCho(seed);
    const notCandidate = await resolveBackgroundCheckReview("r-1", { type: "match", personId: "p-someone-else" }, "admin-1").catch((error: unknown) => error);
    expect(notCandidate).toBeInstanceOf(BackgroundCheckOperationError);
    expect(notCandidate).toMatchObject({ code: "NOT_A_CANDIDATE", status: 400 });
    await expect(resolveBackgroundCheckReview("r-missing", { type: "dismiss" }, "admin-1")).rejects.toMatchObject({ code: "REVIEW_NOT_FOUND", status: 404 });
    expect(seed.reviews.size).toBe(1);
    expect(seed.matches.size).toBe(0);
  });
});

describe("applyBackgroundCheckUpload: concurrent confirms (#527 N1)", () => {
  it("refuses a confirm whose preview was computed against a different list", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    const rows = [sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nAna,Rivera,ana@example.test,2029-01-01")[0]!)];
    const preview = await planBackgroundCheckUpload(rows);
    // Someone else's upload lands between this preview and its confirm.
    await applyBackgroundCheckUpload(rows, "STERLING", "admin-2", new Date("2026-09-28T12:00:00Z"), { expectedFingerprint: preview.fingerprint });
    await expect(applyBackgroundCheckUpload(rows, "STERLING", "admin-1", new Date("2026-09-28T12:00:00Z"), { expectedFingerprint: preview.fingerprint }))
      .rejects.toMatchObject({ code: "PREVIEW_CHANGED", status: 409 });
    expect(seed.uploads.size).toBe(1);
  });

  it("deletes every entry that isn't the new upload's", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    seed.uploads.set("u-old-1", { id: "u-old-1", createdAt: new Date("2026-09-01") });
    seed.uploads.set("u-old-2", { id: "u-old-2", createdAt: new Date("2026-09-02") });
    seedEntry(seed, "e-a", { uploadId: "u-old-1", firstName: "A", lastName: "One", normalizedName: "a one" });
    seedEntry(seed, "e-b", { uploadId: "u-old-2", firstName: "B", lastName: "Two", normalizedName: "b two" });
    const rows = [sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nAna,Rivera,ana@example.test,2029-01-01")[0]!)];
    await applyBackgroundCheckUpload(rows, "STERLING", "admin-1", new Date("2026-09-28T12:00:00Z"));
    expect([...seed.entries.values()].map((entry) => entry.firstName)).toEqual(["Ana"]);
  });
});

describe("flags at youth or children's events (#388, #527)", () => {
  function attendee(id: string, check: Record<string, unknown> | null, overrides: Record<string, unknown> = {}) {
    return {
      id,
      personId: `person-${id}`,
      eventId: "event-1",
      attendeeType: "Pathfinder",
      profileSnapshot: {},
      formResponses: {},
      person: { firstName: "Test", lastName: id, backgroundCheckMatch: check ? { entry: check } : null },
      registration: { id: "reg-1", confirmationCode: "ABC123", status: "CONFIRMED", clubRegistration: null },
      ...overrides,
    };
  }

  beforeEach(() => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    seed.events.set("event-1", {
      id: "event-1",
      checksAdultBackgrounds: true,
      startsAt: new Date("2026-10-02T17:00:00Z"),
      endsAt: new Date("2026-10-04T17:00:00Z"),
      timezone: "America/Chicago",
    });
  });

  it("does nothing for events that don't check", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    seed.events.set("event-1", { id: "event-1", checksAdultBackgrounds: false, startsAt: new Date(), endsAt: new Date(), timezone: "America/Chicago" });
    await expect(listEventBackgroundFlags("event-1")).resolves.toBeNull();
  });

  it("flags every adult without a current check through the last day, and no one else", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    seed.events.set("event-1", {
      id: "event-1", checksAdultBackgrounds: true, startsAt: new Date("2026-10-02T17:00:00Z"), endsAt: new Date("2026-10-04T17:00:00Z"), timezone: "America/Chicago",
    });
    seed.attendees.push(
      attendee("expired", { expiresOn: "2026-10-03", complianceStatus: null }, { attendeeType: "Adult" }),
      attendee("current", { expiresOn: "2026-10-04", complianceStatus: null }, { attendeeType: "Adult" }),
      attendee("none", null, { attendeeType: "Adult" }),
      attendee("pathfinder", null, { profileSnapshot: { ageOnEventDate: 12 } }),
    );
    const flags = await listEventBackgroundFlags("event-1");
    expect(flags?.adults).toBe(3);
    expect(flags?.people.map((flag) => [flag.attendeeId, flag.state])).toEqual([["expired", "EXPIRED"], ["none", "MISSING"]]);
  });
});

describe("club page compliance (#427, #527)", () => {
  function member(id: string, check: Record<string, unknown> | null) {
    return { id, personId: `person-${id}`, organizationId: "org-1", clubYear: "2026", status: "ACTIVE", attendeeType: "ADULT", person: { backgroundCheckMatch: check ? { entry: check } : null } };
  }

  it("counts not in compliance and expiring soon separately, and never counts No record", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    seed.rosterMembers.push(
      member("member-clear", { complianceStatus: "CLEAR", expiresOn: null, issuesNote: null }),
      member("member-soon", { complianceStatus: "FLAGGED", expiresOn: null, issuesNote: "Training expires 2026-11-01" }),
      member("member-not-compliant", { complianceStatus: "NOT_COMPLIANT", expiresOn: null, issuesNote: null }),
      member("member-expired", { complianceStatus: null, expiresOn: "2020-01-01", issuesNote: null }),
      member("member-none", null),
    );
    const result = await clubRosterComplianceStatuses("org-1", "2026", { includeNotes: false });
    expect(Object.fromEntries(Object.entries(result.statuses).map(([id, status]) => [id, status.state]))).toEqual({
      "member-clear": "CLEAR", "member-soon": "FLAGGED", "member-not-compliant": "NOT_COMPLIANT", "member-expired": "NOT_COMPLIANT", "member-none": "NO_RECORD",
    });
    expect(result.notInCompliance).toBe(2);
    expect(result.expiringSoon).toBe(1);
    expect(result.missing).toBe(1);
  });

  it("never includes the note unless the caller is allowed to see it", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    seed.rosterMembers.push(member("member-1", { complianceStatus: "NOT_COMPLIANT", expiresOn: null, issuesNote: "Pending paperwork, Non-Driver" }));
    const forClub = await clubRosterComplianceStatuses("org-1", "2026", { includeNotes: false });
    expect(forClub.statuses["member-1"]).toEqual({ state: "NOT_COMPLIANT", note: null, reasons: [] });
    expect(JSON.stringify(forClub)).not.toContain("Pending paperwork");
    expect(JSON.stringify(forClub)).not.toContain("Non-Driver");
    const forStaff = await clubRosterComplianceStatuses("org-1", "2026", { includeNotes: true });
    expect(forStaff.statuses["member-1"]).toEqual({ state: "NOT_COMPLIANT", note: "Pending paperwork, Non-Driver", reasons: ["Marked Non-Driver"] });
  });

  it("shows a club's own roster the status for directors and deputies only, never a registrar, and never the note", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    seed.rosterMembers.push(member("member-1", { complianceStatus: "FLAGGED", expiresOn: null, issuesNote: "Training expires 2026-11-01" }));
    await expect(clubPortalComplianceStatuses("org-1", "2026", clubCapabilities("REGISTRAR"))).resolves.toBeUndefined();
    for (const role of ["DIRECTOR", "DEPUTY"] as const) {
      await expect(clubPortalComplianceStatuses("org-1", "2026", clubCapabilities(role))).resolves.toEqual({ "member-1": { state: "FLAGGED", note: null, reasons: [] } });
    }
  });

  it("every reader uses the same rule", () => {
    const today = "2026-10-04";
    const rosterClear = { complianceStatus: "CLEAR" as const, expiresOn: null };
    const rosterSoon = { complianceStatus: "FLAGGED" as const, expiresOn: null };
    const rosterNo = { complianceStatus: "NOT_COMPLIANT" as const, expiresOn: null };
    const sterlingCurrent = { complianceStatus: null, expiresOn: "2027-06-01" };
    const sterlingSoon = { complianceStatus: null, expiresOn: "2026-10-04" };
    const sterlingExpired = { complianceStatus: null, expiresOn: "2026-10-03" };
    const checks = [rosterClear, rosterSoon, rosterNo, sterlingCurrent, sterlingSoon, sterlingExpired, null];
    expect(checks.map((check) => backgroundCheckState(check, today))).toEqual(["CURRENT", "CURRENT", "NOT_COMPLIANT", "CURRENT", "CURRENT", "EXPIRED", "MISSING"]);
    expect(checks.map((check) => clubComplianceState(check, today))).toEqual(["CLEAR", "FLAGGED", "NOT_COMPLIANT", "CLEAR", "FLAGGED", "NOT_COMPLIANT", "NO_RECORD"]);
  });

  it("flags a roster-only Not in compliance adult at a youth event, but not a Clear or expiring-soon one", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    seed.events.set("event-1", { id: "event-1", checksAdultBackgrounds: true, startsAt: new Date("2026-10-02T17:00:00Z"), endsAt: new Date("2026-10-04T17:00:00Z"), timezone: "America/Chicago" });
    function attendee(id: string, check: Record<string, unknown> | null) {
      return {
        id, personId: `person-${id}`, eventId: "event-1", attendeeType: "Adult", profileSnapshot: {}, formResponses: {},
        person: { firstName: "Test", lastName: id, backgroundCheckMatch: check ? { entry: check } : null },
        registration: { id: "reg-1", confirmationCode: "ABC123", status: "CONFIRMED", clubRegistration: null },
      };
    }
    seed.attendees.push(
      attendee("roster-clear", { complianceStatus: "CLEAR", expiresOn: null }),
      attendee("roster-soon", { complianceStatus: "FLAGGED", expiresOn: null }),
      attendee("roster-no", { complianceStatus: "NOT_COMPLIANT", expiresOn: null, issuesNote: "Synthetic issue, Non-Driver, BGC" }),
      attendee("none", null),
    );
    const flags = await listEventBackgroundFlags("event-1");
    expect(flags?.adults).toBe(4);
    expect(flags?.people.map((flag) => [flag.attendeeId, flag.state])).toEqual([["roster-no", "NOT_COMPLIANT"], ["none", "MISSING"]]);
    expect(backgroundFlagsCsv(flags!.people)).toContain("Not in compliance");
    // The issues text is for system administrators only (#427, #544): the caller decides with `includeNotes`.
    expect(flags!.people.every((flag) => flag.issuesNote === null)).toBe(true);
    expect(JSON.stringify(flags)).not.toContain("Synthetic");
    const withNotes = await listEventBackgroundFlags("event-1", { includeNotes: true });
    expect(withNotes!.people.map((flag) => [flag.attendeeId, flag.issuesNote])).toEqual([["roster-no", "Synthetic issue, Non-Driver, BGC"], ["none", null]]);
    expect(withNotes!.people[0]!.issueReasons).toEqual(["Marked Non-Driver", "Background check expired"]);
    // Without includeNotes there is no text and no reason: nothing to leak.
    expect(flags!.people.every((flag) => flag.issueReasons.length === 0)).toBe(true);
    expect(JSON.stringify(flags)).not.toContain("Non-Driver");
    expect(backgroundFlagsCsv(withNotes!.people)).not.toContain("Synthetic");
  });
});

describe("read-time matching for people the cache hasn't matched yet (#527 B5)", () => {
  function youthEvent(seed: ReturnType<typeof makeFakeDb>["seed"]) {
    seed.events.set("event-1", { id: "event-1", checksAdultBackgrounds: true, startsAt: new Date("2026-10-02T17:00:00Z"), endsAt: new Date("2026-10-04T17:00:00Z"), timezone: "America/Chicago" });
  }
  function registeredAdult(id: string, firstName: string, lastName: string, extra: { email?: string; responses?: Row } = {}) {
    return {
      id: `att-${id}`, personId: id, eventId: "event-1", attendeeType: "Adult",
      profileSnapshot: extra.email ? { email: extra.email } : {}, formResponses: extra.responses ?? {},
      person: { firstName, lastName, normalizedEmail: null, attendeeAccountLinks: [], backgroundCheckMatch: null },
      registration: { id: `reg-${id}`, confirmationCode: `C-${id}`, status: "CONFIRMED", clubRegistration: null },
    };
  }

  it("flags a newly registered adult who is on the list as checked, with no refresh and no re-upload", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    youthEvent(seed);
    const rows = [sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nJosé,Núñez,jose@example.test,2029-01-01")[0]!)];
    await applyBackgroundCheckUpload(rows, "STERLING", "admin-1", new Date("2026-09-28T12:00:00Z"));
    // Registered afterward (a write path that never refreshed the cache), under an unaccented spelling.
    seed.attendees.push(registeredAdult("p-jose", "Jose", "Nunez", { email: "JOSE@example.test" }), registeredAdult("p-none", "Pat", "Nobody"));
    expect(seed.matches.size).toBe(0);
    const flags = await listEventBackgroundFlags("event-1");
    expect(flags?.adults).toBe(2);
    expect(flags?.people.map((flag) => flag.attendeeId)).toEqual(["att-p-none"]);
  });

  it("matches on a form birth date too", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    youthEvent(seed);
    const rows = [sterlingRowToListRow(parseSterlingCsv("First name,Last name,Birth date,Expiration date\nAna,Rivera,1985-04-17,2026-10-01")[0]!)];
    await applyBackgroundCheckUpload(rows, "STERLING", "admin-1", new Date("2026-09-28T12:00:00Z"));
    seed.attendees.push(registeredAdult("p-ana", "Ana", "Rivera", { responses: { date_of_birth: "4/17/1985" } }));
    const flags = await listEventBackgroundFlags("event-1");
    // On the list, but that check expires before the event ends: flagged as expired, not missing.
    expect(flags?.people.map((flag) => [flag.attendeeId, flag.state, flag.expiresOn])).toEqual([["att-p-ana", "EXPIRED", "2026-10-01"]]);
  });

  it("leaves an ambiguous read-time match unmatched, never guessed", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    youthEvent(seed);
    const rows = [sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nKim,Cho,kim@example.test,2029-01-01")[0]!)];
    await applyBackgroundCheckUpload(rows, "STERLING", "admin-1", new Date("2026-09-28T12:00:00Z"));
    seed.attendees.push(registeredAdult("p-kim-1", "Kim", "Cho", { email: "kim@example.test" }), registeredAdult("p-kim-2", "Kim", "Cho", { email: "kim@example.test" }));
    const flags = await listEventBackgroundFlags("event-1");
    expect(flags?.people.map((flag) => [flag.attendeeId, flag.state])).toEqual([["att-p-kim-1", "MISSING"], ["att-p-kim-2", "MISSING"]]);
  });

  it("never matches one entry to two people on different club pages (another person anywhere counts)", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    // The list says Dana Lee at the church that sponsors both clubs.
    const [row] = parseRosterBackgroundCsv("user_id,user_last,user_first,sites,compliance\n5001,Lee,Dana,Verify Church,y");
    await applyBackgroundCheckUpload([rosterRowToListRow(row!)], "ROSTER", "admin-1", new Date("2026-09-28T12:00:00Z"));
    // Two different Dana Lees join two clubs afterward, with no refresh.
    for (const [personId, organizationId, clubName] of [["p-dana-1", "org-1", "Club One"], ["p-dana-2", "org-2", "Club Two"]] as const) {
      seed.persons.set(personId, { id: personId, firstName: "Dana", lastName: "Lee" });
      seed.rosterMembers.push({
        id: `member-${personId}`, personId, organizationId, clubYear: clubYearFor(new Date()), status: "ACTIVE", attendeeType: "ADULT", sealedBirthDate: null,
        organization: { name: clubName, parentOrganization: { name: "Verify Church" } },
        person: { firstName: "Dana", lastName: "Lee", normalizedEmail: null, attendeeAccountLinks: [], backgroundCheckMatch: null },
      });
    }
    const clubOne = await clubRosterComplianceStatuses("org-1", clubYearFor(new Date()), { includeNotes: false });
    const clubTwo = await clubRosterComplianceStatuses("org-2", clubYearFor(new Date()), { includeNotes: false });
    expect(clubOne.statuses["member-p-dana-1"]?.state).toBe("NO_RECORD");
    expect(clubTwo.statuses["member-p-dana-2"]?.state).toBe("NO_RECORD");
  });

  it("never overrides a staff dismissal at read time", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    const [row] = parseRosterBackgroundCsv("user_id,user_last,user_first,sites,compliance\n5001,Lee,Dana,Club One,y");
    await applyBackgroundCheckUpload([rosterRowToListRow(row!)], "ROSTER", "admin-1", new Date("2026-09-28T12:00:00Z"));
    const [entry] = [...seed.entries.values()];
    seed.reviews.set("r-1", { id: "r-1", entryId: entry!.id, reason: "Ambiguous.", candidatePersonIds: ["p-dana-1", "p-x"], dismissedAt: new Date(), createdAt: new Date() });
    seed.rosterMembers.push({
      id: "member-dana", personId: "p-dana-1", organizationId: "org-1", clubYear: "2026", status: "ACTIVE", attendeeType: "ADULT", sealedBirthDate: null,
      organization: { name: "Club One", parentOrganization: null },
      person: { firstName: "Dana", lastName: "Lee", normalizedEmail: null, attendeeAccountLinks: [], backgroundCheckMatch: null },
    });
    const statuses = await clubRosterComplianceStatuses("org-1", "2026", { includeNotes: false });
    expect(statuses.statuses["member-dana"]?.state).toBe("NO_RECORD");
  });

  it("never matches at read time an entry that's waiting on a staff review", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    youthEvent(seed);
    const rows = [sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nKim,Cho,kim@example.test,2029-01-01")[0]!)];
    await applyBackgroundCheckUpload(rows, "STERLING", "admin-1", new Date("2026-09-28T12:00:00Z"));
    const [entry] = [...seed.entries.values()];
    seed.reviews.set("r-1", { id: "r-1", entryId: entry!.id, reason: "Ambiguous.", candidatePersonIds: ["p-kim-1", "p-other"], createdAt: new Date() });
    seed.attendees.push(registeredAdult("p-kim-1", "Kim", "Cho", { email: "kim@example.test" }));
    const flags = await listEventBackgroundFlags("event-1");
    expect(flags?.people.map((flag) => flag.state)).toEqual(["MISSING"]);
  });

  it("shows a club roster adult on the list by name plus club, with the note for staff only", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    const [row] = parseRosterBackgroundCsv("user_id,user_last,user_first,sites,compliance,issues\n9001,Rivera-Lopez,María,Test Pathfinders,!,Training expires 2026-11-01");
    await applyBackgroundCheckUpload([rosterRowToListRow(row!)], "ROSTER", "admin-1", new Date("2026-09-28T12:00:00Z"));
    // Added to the roster after the upload, by a path that didn't refresh.
    seed.rosterMembers.push({
      id: "member-maria", personId: "p-maria", organizationId: "org-1", clubYear: "2026", status: "ACTIVE", attendeeType: "ADULT", sealedBirthDate: null,
      organization: { name: "Test Pathfinders", parentOrganization: null },
      person: { firstName: "Maria", lastName: "Rivera-Lopez", normalizedEmail: null, attendeeAccountLinks: [], backgroundCheckMatch: null },
    });
    const forClub = await clubRosterComplianceStatuses("org-1", "2026", { includeNotes: false });
    expect(forClub.statuses["member-maria"]).toEqual({ state: "FLAGGED", note: null, reasons: [] });
    expect(forClub.missing).toBe(0);
    const forStaff = await clubRosterComplianceStatuses("org-1", "2026", { includeNotes: true });
    expect(forStaff.statuses["member-maria"]).toEqual({ state: "FLAGGED", note: "Training expires 2026-11-01", reasons: [] });
    await expect(clubComplianceReminderCounts("org-1", "2026")).resolves.toEqual({ notInCompliance: 0, expiringSoon: 1, missing: 0 });
  });
});

describe("Club home and club overview compliance reminders (#479, #527)", () => {
  function member(id: string, check: Record<string, unknown> | null) {
    return { id, personId: `person-${id}`, organizationId: "org-1", clubYear: "2026", status: "ACTIVE", attendeeType: "ADULT", person: { backgroundCheckMatch: check ? { entry: check } : null } };
  }

  it("returns missing, not-in-compliance, and expiring-soon counts, never the per-member statuses or a note", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    seed.rosterMembers.push(
      member("member-clear", { complianceStatus: "CLEAR", expiresOn: null, issuesNote: null }),
      member("member-soon", { complianceStatus: "FLAGGED", expiresOn: null, issuesNote: "Training expires 2026-11-01" }),
      member("member-not-compliant", { complianceStatus: "NOT_COMPLIANT", expiresOn: null, issuesNote: null }),
      member("member-expired", { complianceStatus: null, expiresOn: "2020-01-01", issuesNote: null }),
      member("member-none", null),
    );
    const counts = await clubComplianceReminderCounts("org-1", "2026");
    expect(counts).toEqual({ notInCompliance: 2, expiringSoon: 1, missing: 1 });
    expect(JSON.stringify(counts)).not.toContain("Training expires");
    expect(JSON.stringify(counts)).not.toContain("member-");
  });

  it("turns counts into reminder lines with a filtered-roster link each, skipping any count that's zero", () => {
    const items = complianceReminders({ missing: 3, notInCompliance: 2, expiringSoon: 1 }, "/account/clubs/club-1/roster");
    expect(items).toEqual([
      { key: "background-check-missing", text: "3 adults missing a current background check.", href: "/account/clubs/club-1/roster?compliance=missing" },
      { key: "background-check-not-compliant", text: "2 background checks expired or not in compliance.", href: "/account/clubs/club-1/roster?compliance=expired" },
      { key: "background-check-expiring", text: "1 background check expires within 60 days.", href: "/account/clubs/club-1/roster?compliance=expiring" },
    ]);
  });

  it("shows nothing when every count is zero", () => {
    expect(complianceReminders({ missing: 0, notInCompliance: 0, expiringSoon: 0 }, "/account/clubs/club-1/roster")).toEqual([]);
  });
});

describe("Club home reminder gate (#479 review, #527)", () => {
  it("gives directors and deputies counts and registrars nothing, the same rule as the roster column", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    seed.rosterMembers.push({ id: "m-1", personId: "person-1", organizationId: "org-1", clubYear: "2026", status: "ACTIVE", attendeeType: "ADULT", person: { backgroundCheckMatch: null } });
    await expect(clubPortalComplianceReminderCounts("org-1", "2026", clubCapabilities("REGISTRAR"))).resolves.toBeNull();
    const director = await clubPortalComplianceReminderCounts("org-1", "2026", clubCapabilities("DIRECTOR"));
    expect(director).toEqual(expect.objectContaining({ missing: expect.any(Number), expiringSoon: expect.any(Number), notInCompliance: expect.any(Number) }));
  });
});

describe("the system administrator's summary (#527)", () => {
  it("counts current, expiring soon, not current, review, and unmatched", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    const uploadId = "u-1";
    seed.uploads.set(uploadId, { id: uploadId, createdAt: new Date("2026-09-01") });
    seed.entries.set("e-current", { id: "e-current", uploadId, complianceStatus: null, expiresOn: "2027-01-01" });
    seed.entries.set("e-soon", { id: "e-soon", uploadId, complianceStatus: "FLAGGED", expiresOn: null });
    seed.entries.set("e-expired", { id: "e-expired", uploadId, complianceStatus: null, expiresOn: "2020-01-01" });
    seed.entries.set("e-unmatched", { id: "e-unmatched", uploadId, complianceStatus: null, expiresOn: "2027-01-01", firstName: "Pat", lastName: "Nobody" });
    seed.matches.set("m-current", { id: "m-current", personId: "p-1", entryId: "e-current", matchedBy: "AUTO", createdAt: new Date(), updatedAt: new Date("2026-09-01") });
    seed.matches.set("m-soon", { id: "m-soon", personId: "p-2", entryId: "e-soon", matchedBy: "AUTO", createdAt: new Date(), updatedAt: new Date("2026-09-01") });
    seed.matches.set("m-expired", { id: "m-expired", personId: "p-3", entryId: "e-expired", matchedBy: "AUTO", createdAt: new Date(), updatedAt: new Date("2026-09-01") });
    const summary = await backgroundCheckSummary("2026-10-04");
    // "Current" counts both a dated Sterling check and a CLEAR/FLAGGED roster mark.
    expect(summary.current).toBe(2);
    expect(summary.expiringSoon).toBe(1);
    expect(summary.notCurrent).toBe(1);
    expect(summary.unmatchedCount).toBe(1);
  });
});

describe("first-name variants (#598)", () => {
  it("treats a prefix or contained first name of three or more characters as a variant, never an equal name", () => {
    expect(firstNameVariant("Jon", "Jonathan")).toBe(true);
    expect(firstNameVariant("Nessa", "Vanessa")).toBe(true);
    expect(firstNameVariant("Jonathan", "Jon")).toBe(true);
    expect(firstNameVariant("Jon", "Jon")).toBe(false);
    expect(firstNameVariant("Al", "Alan")).toBe(false);
    expect(firstNameVariant("Rita", "Marco")).toBe(false);
    expect(firstNameVariant("Liz", "Elizabeth")).toBe(true); // contained, so it is suggested too
  });

  it("reads a typed name as first and last, or last, first", () => {
    expect(parseLookupName("Mina  Osei")).toEqual({ firstName: "Mina", lastName: "Osei" });
    expect(parseLookupName("Osei, Mina")).toEqual({ firstName: "Mina", lastName: "Osei" });
    expect(parseLookupName("Osei")).toEqual({ firstName: "", lastName: "Osei" });
  });
});

describe("name-only matches, variants, adults by age, and the lookup (#598)", () => {
  const now = new Date("2026-09-29T12:00:00Z");
  const otherChurch = "Faraway Hills SDA Church (Elsewhere)";
  function rosterRows(...rows: Array<{ userId: string; last: string; first: string; sites: string; email?: string }>) {
    const csv = ["user_id,user_last,user_first,sites,compliance", ...rows.map((row) => `${row.userId},${row.last},${row.first},"${row.sites}",y`)].join("\n");
    return parseRosterBackgroundCsv(csv).map(rosterRowToListRow);
  }
  const mapleGrove = { clubName: "Maple Grove Pathfinders", parentName: "Maple Grove SDA Church" };

  it("matches the only same-name adult even when the site is a different church, and records it as name only", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    rosterAdult(seed, "p-mina", "Mina", "Osei", mapleGrove);
    await applyBackgroundCheckUpload(rosterRows({ userId: "7001", last: "Osei", first: "Mina", sites: otherChurch }), "ROSTER", "admin-1", now);
    expect([...seed.matches.values()]).toEqual([expect.objectContaining({ personId: "p-mina", matchedBy: "NAME_ONLY" })]);
    expect(seed.reviews.size).toBe(0);
    // A guess staff spot-check never becomes a remembered id.
    expect(seed.identities.size).toBe(0);
    await expect(listNameOnlyBackgroundCheckMatches(now)).resolves.toEqual([
      expect.objectContaining({ personName: "Mina Osei", entryName: "Mina Osei", site: otherChurch, personSites: ["Maple Grove Pathfinders", "Maple Grove SDA Church"] }),
    ]);
  });

  it("still marks a site match as AUTO, so name-only lists only the site misses", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    rosterAdult(seed, "p-mina", "Mina", "Osei", mapleGrove);
    await applyBackgroundCheckUpload(rosterRows({ userId: "7001", last: "Osei", first: "Mina", sites: "Maple Grove SDA Church (Springfield)" }), "ROSTER", "admin-1", now);
    expect([...seed.matches.values()].map((match) => match.matchedBy)).toEqual(["AUTO"]);
    await expect(listNameOnlyBackgroundCheckMatches(now)).resolves.toEqual([]);
  });

  it("sends two same-name candidates with nothing to separate them to review", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    rosterAdult(seed, "p-lee-1", "Lee", "Park", mapleGrove);
    rosterAdult(seed, "p-lee-2", "Lee", "Park", { clubName: "Cedar Hill Pathfinders", parentName: "Cedar Hill SDA Church" });
    await applyBackgroundCheckUpload(rosterRows({ userId: "8001", last: "Park", first: "Lee", sites: otherChurch }), "ROSTER", "admin-1", now);
    expect(seed.matches.size).toBe(0);
    const [review] = [...seed.reviews.values()];
    expect((review!.candidatePersonIds as string[]).sort()).toEqual(["p-lee-1", "p-lee-2"]);
  });

  it("sends two list rows with one name and one candidate to review", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    rosterAdult(seed, "p-mina", "Mina", "Osei", mapleGrove);
    await applyBackgroundCheckUpload(rosterRows(
      { userId: "7001", last: "Osei", first: "Mina", sites: otherChurch },
      { userId: "7002", last: "Osei", first: "Mina", sites: "Another Town SDA Church (Elsewhere)" },
    ), "ROSTER", "admin-1", now);
    expect(seed.matches.size).toBe(0);
    expect(seed.reviews.size).toBe(2);
    expect([...seed.reviews.values()].every((review) => (review.candidatePersonIds as string[]).join() === "p-mina")).toBe(true);
  });

  it("does not match by name alone when another person on file has the name, even one on no roster (the MO/IA case)", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    rosterAdult(seed, "p-nell-ia", "Nell", "Hart", { clubName: "Nevada (IA) Pathfinders", parentName: "Nevada (IA) SDA Church" });
    seed.persons.set("p-nell-mo", { id: "p-nell-mo", firstName: "Nell", lastName: "Hart" });
    await applyBackgroundCheckUpload(rosterRows({ userId: "8201", last: "Hart", first: "Nell", sites: "Nevada (MO) SDA Church (Nevada)" }), "ROSTER", "admin-1", now);
    expect(seed.matches.size).toBe(0);
    expect(seed.reviews.size).toBe(1);
  });

  it("leaves a row unmatched when its email or birth date contradicts the only candidate", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    rosterAdult(seed, "p-mina", "Mina", "Osei", { ...mapleGrove, email: "mina@example.test" });
    const [row] = rosterRows({ userId: "7001", last: "Osei", first: "Mina", sites: otherChurch });
    await applyBackgroundCheckUpload([{ ...row!, email: "someone-else@example.test" }], "ROSTER", "admin-1", now);
    expect(seed.matches.size).toBe(0);
    expect(seed.reviews.size).toBe(0);
  });

  it("'Not the same person' unmatches the row and keeps it unmatched on later refreshes", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    rosterAdult(seed, "p-mina", "Mina", "Osei", mapleGrove);
    await applyBackgroundCheckUpload(rosterRows({ userId: "7001", last: "Osei", first: "Mina", sites: otherChurch }), "ROSTER", "admin-1", now);
    const [match] = [...seed.matches.values()];
    await rejectNameOnlyBackgroundCheckMatch(match!.id as string, "admin-1");
    expect(seed.matches.size).toBe(0);
    expect(await listBackgroundCheckReviews()).toEqual([]); // not waiting on anyone
    expect([...seed.reviews.values()]).toEqual([expect.objectContaining({ dismissedAt: expect.any(Date), candidatePersonIds: [] })]);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "BACKGROUND_CHECK_NAME_ONLY_MATCH_REJECTED", metadata: { entryId: expect.any(String) } }), expect.anything());
    expect(JSON.stringify(auditLog.mock.calls.at(-1))).not.toContain("Osei");

    await refreshBackgroundCheckMatchForPerson("p-mina", now);
    expect(seed.matches.size).toBe(0);
    await rematchBackgroundCheckList(now);
    expect(seed.matches.size).toBe(0);
    expect((await listUnmatchedBackgroundCheckEntries()).map((entry) => entry.firstName)).toEqual(["Mina"]);
  });

  it("only undoes a name-only match, and a missing match is a 404", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    rosterAdult(seed, "p-mina", "Mina", "Osei", mapleGrove);
    await applyBackgroundCheckUpload(rosterRows({ userId: "7001", last: "Osei", first: "Mina", sites: "Maple Grove SDA Church (Springfield)" }), "ROSTER", "admin-1", now);
    const [autoMatch] = [...seed.matches.values()];
    await expect(rejectNameOnlyBackgroundCheckMatch(autoMatch!.id as string, "admin-1")).rejects.toMatchObject({ code: "NOT_A_NAME_ONLY_MATCH", status: 400 });
    await expect(rejectNameOnlyBackgroundCheckMatch("missing", "admin-1")).rejects.toMatchObject({ code: "MATCH_NOT_FOUND", status: 404 });
    expect(seed.matches.size).toBe(1);
  });

  it("creates a review, never a match, for a first-name variant with the same last name", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    rosterAdult(seed, "p-jonathan", "Jonathan", "Reyes", mapleGrove);
    rosterAdult(seed, "p-vanessa", "Vanessa", "Cole", mapleGrove);
    rosterAdult(seed, "p-alan", "Alan", "Frost", mapleGrove);
    await applyBackgroundCheckUpload(rosterRows(
      { userId: "6001", last: "Reyes", first: "Jon", sites: "Maple Grove SDA Church (Springfield)" },
      { userId: "6002", last: "Cole", first: "Nessa", sites: otherChurch },
      { userId: "6003", last: "Frost", first: "Al", sites: "Maple Grove SDA Church (Springfield)" }, // too short to suggest
      { userId: "6004", last: "Other", first: "Jonathan", sites: "Maple Grove SDA Church (Springfield)" }, // different last name
    ), "ROSTER", "admin-1", now);
    expect(seed.matches.size).toBe(0);
    const reviews = await listBackgroundCheckReviews();
    expect(reviews.map((review) => [review.name, review.candidates.map((candidate) => candidate.name)]).sort()).toEqual([
      ["Jon Reyes", ["Jonathan Reyes"]],
      ["Nessa Cole", ["Vanessa Cole"]],
    ]);
    // Staff can confirm the suggestion by hand.
    const jon = reviews.find((review) => review.name === "Jon Reyes")!;
    await resolveBackgroundCheckReview(jon.id, { type: "match", personId: "p-jonathan" }, "admin-1");
    expect([...seed.matches.values()]).toEqual([expect.objectContaining({ personId: "p-jonathan", matchedBy: "MANUAL" })]);
  });

  it("counts a roster member 18 or older as a candidate whatever their type, and not a younger one", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    rosterAdult(seed, "p-older", "Odell", "Grant", { ...mapleGrove, attendeeType: "YOUTH", sealedBirthDate: "sealed:1990-03-04" });
    rosterAdult(seed, "p-younger", "Yara", "Grant", { ...mapleGrove, attendeeType: "YOUTH", sealedBirthDate: "sealed:2012-03-04" });
    rosterAdult(seed, "p-eighteen", "Edda", "Grant", { ...mapleGrove, attendeeType: "UNDERAGE", sealedBirthDate: "sealed:2008-09-29" });
    rosterAdult(seed, "p-turns-tomorrow", "Tomi", "Grant", { ...mapleGrove, attendeeType: "YOUTH", sealedBirthDate: "sealed:2008-09-30" });
    await applyBackgroundCheckUpload(rosterRows(
      { userId: "5001", last: "Grant", first: "Odell", sites: "Maple Grove SDA Church (Springfield)" },
      { userId: "5002", last: "Grant", first: "Yara", sites: "Maple Grove SDA Church (Springfield)" },
      { userId: "5003", last: "Grant", first: "Edda", sites: "Maple Grove SDA Church (Springfield)" },
      { userId: "5004", last: "Grant", first: "Tomi", sites: "Maple Grove SDA Church (Springfield)" },
    ), "ROSTER", "admin-1", now);
    expect([...seed.matches.values()].map((match) => match.personId).sort()).toEqual(["p-eighteen", "p-older"]);
  });

  it("re-matches stored entries under the new rules with a staff Refresh and no new upload, keeping staff decisions", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    seed.uploads.set("u-1", { id: "u-1", createdAt: new Date("2026-09-01") });
    rosterAdult(seed, "p-mina", "Mina", "Osei", mapleGrove);
    rosterAdult(seed, "p-jonathan", "Jonathan", "Reyes", mapleGrove);
    rosterAdult(seed, "p-hand", "Hana", "Ito", mapleGrove);
    rosterAdult(seed, "p-other", "Otis", "Ito", mapleGrove);
    seedEntry(seed, "e-mina", { identityKey: "userId:7001", sourceUserId: "7001", firstName: "Mina", lastName: "Osei", normalizedName: "mina osei", site: otherChurch });
    seedEntry(seed, "e-jon", { identityKey: "userId:7002", sourceUserId: "7002", firstName: "Jon", lastName: "Reyes", normalizedName: "jon reyes", site: otherChurch });
    seedEntry(seed, "e-hand", { identityKey: "userId:7003", sourceUserId: "7003", firstName: "Hana", lastName: "Ito", normalizedName: "hana ito", site: otherChurch });
    seed.matches.set("m-hand", { id: "m-hand", personId: "p-hand", entryId: "e-hand", matchedBy: "MANUAL", createdAt: new Date(), updatedAt: new Date() });
    await rematchBackgroundCheckList(now);
    const matches = [...seed.matches.values()].map((match) => [match.entryId, match.personId, match.matchedBy]);
    expect(matches).toEqual(expect.arrayContaining([["e-mina", "p-mina", "NAME_ONLY"], ["e-hand", "p-hand", "MANUAL"]]));
    expect(matches).toHaveLength(2);
    expect([...seed.reviews.values()].map((review) => [review.entryId, review.candidatePersonIds])).toEqual([["e-jon", ["p-jonathan"]]]);
    // Running it again changes nothing.
    await rematchBackgroundCheckList(now);
    expect(seed.matches.size).toBe(2);
    expect(seed.reviews.size).toBe(1);
  });

  it("refuses a Refresh during an upload rather than waiting", async () => {
    const { client, lock } = makeFakeDb();
    currentClient = client;
    lock.held = true;
    await expect(rematchBackgroundCheckList(now)).rejects.toMatchObject({ code: "UPLOAD_IN_PROGRESS", status: 409 });
  });

  describe("the 'why isn't this person matched' lookup", () => {
    async function seededLookup() {
      const { client, seed } = makeFakeDb();
      currentClient = client;
      seed.uploads.set("u-1", { id: "u-1", createdAt: new Date("2026-09-01") });
      // Matched by name only.
      rosterAdult(seed, "p-mina", "Mina", "Osei", { ...mapleGrove, sealedBirthDate: "sealed:1985-04-17" });
      seedEntry(seed, "e-mina", { identityKey: "userId:1", firstName: "Mina", lastName: "Osei", normalizedName: "mina osei", site: otherChurch });
      // A similar first name.
      rosterAdult(seed, "p-jonathan", "Jonathan", "Reyes", mapleGrove);
      seedEntry(seed, "e-jon", { identityKey: "userId:2", firstName: "Jon", lastName: "Reyes", normalizedName: "jon reyes", site: otherChurch });
      // Not an adult on a roster.
      seed.persons.set("p-yara", { id: "p-yara", firstName: "Yara", lastName: "Grant" });
      rosterAdult(seed, "p-yara", "Yara", "Grant", { ...mapleGrove, attendeeType: "YOUTH", sealedBirthDate: "sealed:2012-03-04" });
      seedEntry(seed, "e-yara", { identityKey: "userId:3", firstName: "Yara", lastName: "Grant", normalizedName: "yara grant", site: "Maple Grove SDA Church (Springfield)" });
      // More than one candidate.
      rosterAdult(seed, "p-lee-1", "Lee", "Park", mapleGrove);
      rosterAdult(seed, "p-lee-2", "Lee", "Park", { clubName: "Cedar Hill Pathfinders", parentName: "Cedar Hill SDA Church" });
      seedEntry(seed, "e-lee", { identityKey: "userId:4", firstName: "Lee", lastName: "Park", normalizedName: "lee park", site: otherChurch });
      // Already matched to another row.
      rosterAdult(seed, "p-ana", "Ana", "Wolf", mapleGrove);
      seedEntry(seed, "e-ana-1", { identityKey: "userId:5", firstName: "Ana", lastName: "Wolf", normalizedName: "ana wolf", site: "Maple Grove SDA Church (Springfield)" });
      seedEntry(seed, "e-ana-2", { identityKey: "userId:6", firstName: "Ana", lastName: "Wolf", normalizedName: "ana wolf", site: otherChurch });
      // Previously marked "not the same person".
      rosterAdult(seed, "p-rex", "Rex", "Dunn", mapleGrove);
      seedEntry(seed, "e-rex", { identityKey: "userId:7", firstName: "Rex", lastName: "Dunn", normalizedName: "rex dunn", site: otherChurch });
      seed.reviews.set("r-rex", { id: "r-rex", entryId: "e-rex", reason: "Staff said no.", candidatePersonIds: [], dismissedAt: new Date(), createdAt: new Date() });
      // Site differs but the name is unique: waits for Refresh.
      rosterAdult(seed, "p-sam", "Sam", "Yoon", mapleGrove);
      seedEntry(seed, "e-sam", { identityKey: "userId:8", firstName: "Sam", lastName: "Yoon", normalizedName: "sam yoon", site: otherChurch });
      await rematchBackgroundCheckList(now);
      return seed;
    }
    const reasonFor = (lookup: Awaited<ReturnType<typeof lookupBackgroundCheckName>>, row: string, person: string) => (
      lookup.pairs.find((pair) => pair.rowName === row && pair.personName === person)?.reason ?? ""
    );

    it("explains each kind of non-match in plain words", async () => {
      await seededLookup();
      const jon = await lookupBackgroundCheckName("Reyes", now);
      expect(reasonFor(jon, "Jon Reyes", "Jonathan Reyes")).toMatch(/first name differs.*sent to review/i);
      const yara = await lookupBackgroundCheckName("Yara Grant", now);
      expect(reasonFor(yara, "Yara Grant", "Yara Grant")).toMatch(/not an adult on a current or previous-year club roster.*maple grove pathfinders roster as youth/i);
      expect(yara.people[0]!.status).toMatch(/not an adult/i);
      const lee = await lookupBackgroundCheckName("Lee Park", now);
      expect(reasonFor(lee, "Lee Park", "Lee Park")).toMatch(/sent to review.*more than one person/i);
      const ana = await lookupBackgroundCheckName("Ana Wolf", now);
      const anaReasons = ana.pairs.map((pair) => pair.reason);
      expect(anaReasons.some((reason) => /matched by name and site/i.test(reason))).toBe(true);
      expect(anaReasons.some((reason) => /sent to review.*more than one row/i.test(reason))).toBe(false); // the second row has no reviewable candidate left
      expect(anaReasons.some((reason) => /already matched to another row/i.test(reason))).toBe(true);
      const rex = await lookupBackgroundCheckName("Dunn, Rex", now);
      expect(reasonFor(rex, "Rex Dunn", "Rex Dunn")).toMatch(/not the same person/i);
      const mina = await lookupBackgroundCheckName("mina osei", now);
      expect(reasonFor(mina, "Mina Osei", "Mina Osei")).toMatch(/matched by name only/i);
      expect(mina.rows[0]!.status).toMatch(/matched by name only to Mina Osei/i);
    });

    it("explains a site difference that a Refresh has not resolved yet", async () => {
      const seed = await seededLookup();
      seed.matches.clear();
      seed.reviews.delete("r-rex");
      const sam = await lookupBackgroundCheckName("Sam Yoon", now);
      expect(reasonFor(sam, "Sam Yoon", "Sam Yoon")).toMatch(/site differs \(row: Faraway Hills.*person: Maple Grove.*name is unique, so it matches by name only on the next Refresh/i);
    });

    it("finds a similar first name and a last-name-only search, and says so when nothing is close", async () => {
      await seededLookup();
      const jonSearch = await lookupBackgroundCheckName("Jonathan Reyes", now);
      expect(jonSearch.rows.map((row) => row.name)).toEqual(["Jon Reyes"]);
      expect(jonSearch.people.map((person) => person.name)).toEqual(["Jonathan Reyes"]);
      const lastOnly = await lookupBackgroundCheckName("Park", now);
      expect(lastOnly.people).toHaveLength(2);
      const none = await lookupBackgroundCheckName("Nobodyfound", now);
      expect(none).toMatchObject({ hasList: true, rows: [], people: [], pairs: [] });
      expect(await lookupBackgroundCheckName("   ", now)).toMatchObject({ rows: [], people: [], pairs: [] });
    });

    it("never shows a birth date or an email", async () => {
      await seededLookup();
      const everything = JSON.stringify([
        await lookupBackgroundCheckName("Osei", now),
        await lookupBackgroundCheckName("Grant", now),
        await lookupBackgroundCheckName("Park", now),
      ]);
      expect(everything).not.toMatch(/1985|2012|sealed|birth date":|@/);
    });
  });
});
