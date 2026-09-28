import { beforeEach, describe, expect, it, vi } from "vitest";

// --- A small in-memory fake Prisma, just enough for the background-checks
// repository's own queries (#527). Swapped out per describe block for the
// simpler per-call mocks the read-path tests already used. ---

type Row = Record<string, unknown>;

function nextIdFactory() {
  let counter = 0;
  return (prefix: string) => `${prefix}-${(counter += 1)}`;
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
  const attendees: Row[] = [];
  const events = new Map<string, Row>();

  function entryFilter(entry: Row, where: Row): boolean {
    for (const [key, condition] of Object.entries(where)) {
      const value = entry[key];
      if (condition === null) {
        if (value !== null && value !== undefined) return false;
        continue;
      }
      if (condition && typeof condition === "object") {
        const c = condition as Row;
        if ("in" in c) { if (!(c.in as unknown[]).includes(value)) return false; continue; }
        if ("gte" in c && !((value as string) >= (c.gte as string))) return false;
        if ("lte" in c && !((value as string) <= (c.lte as string))) return false;
        if ("lt" in c && !((value as string) < (c.lt as string))) return false;
        continue;
      }
      if (value !== condition) return false;
    }
    return true;
  }

  function rosterWhere(member: Row, where: Row): boolean {
    if (where.organizationId && member.organizationId !== where.organizationId) return false;
    if (where.clubYear && member.clubYear !== where.clubYear) return false;
    if (where.status && member.status !== where.status) return false;
    const attendeeType = where.attendeeType as { in?: string[] } | undefined;
    if (attendeeType?.in && !attendeeType.in.includes(member.attendeeType as string)) return false;
    if (where.person) {
      const person = member.person as Row;
      const filter = where.person as Row;
      const first = filter.firstName as { equals: string } | undefined;
      const last = filter.lastName as { equals: string } | undefined;
      if (first && (person.firstName as string).toLowerCase() !== first.equals.toLowerCase()) return false;
      if (last && (person.lastName as string).toLowerCase() !== last.equals.toLowerCase()) return false;
    }
    return true;
  }

  function attendeeWhere(attendee: Row, where: Row): boolean {
    const event = attendee.event as Row;
    const endsAt = where.event as { endsAt?: { gte: Date } } | undefined;
    if (endsAt?.endsAt && !((event.endsAt as Date) >= endsAt.endsAt.gte)) return false;
    if (where.eventId && attendee.eventId !== where.eventId) return false;
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
    if (where.person) {
      const person = attendee.person as Row;
      const filter = where.person as Row;
      const first = filter.firstName as { equals: string } | undefined;
      const last = filter.lastName as { equals: string } | undefined;
      if (first && (person.firstName as string).toLowerCase() !== first.equals.toLowerCase()) return false;
      if (last && (person.lastName as string).toLowerCase() !== last.equals.toLowerCase()) return false;
    }
    return true;
  }

  const entryFindMany = async ({ where }: { where?: Row } = {}) => {
    let list = [...entries.values()];
    if (where?.uploadId) list = list.filter((entry) => entry.uploadId === where.uploadId);
    if (where?.normalizedName) list = list.filter((entry) => entry.normalizedName === where.normalizedName);
    if (where?.id && (where.id as Row).in) list = list.filter((entry) => (((where!.id as Row).in) as string[]).includes(entry.id as string));
    if (where?.match === null) list = list.filter((entry) => ![...matches.values()].some((match) => match.entryId === entry.id));
    if (where?.reviews) list = list.filter((entry) => ![...reviews.values()].some((review) => review.entryId === entry.id));
    return list.map((entry) => ({ ...entry }));
  };

  const client = {
    person: {
      findUnique: async ({ where }: { where: { id: string } }) => (persons.get(where.id) ? { ...persons.get(where.id) } : null),
      findMany: async ({ where }: { where?: { id?: { in: string[] } } } = {}) => {
        let list = [...persons.values()];
        if (where?.id?.in) list = list.filter((person) => where.id!.in.includes(person.id as string));
        return list.map((person) => ({
          ...person,
          clubRosterMemberships: rosterMembers
            .filter((member) => member.personId === person.id && member.status === "ACTIVE")
            .map((member) => ({ organization: { name: (member.organization as Row).name } })),
        }));
      },
    },
    backgroundCheckUpload: {
      findFirst: async () => {
        const list = [...uploads.values()].sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime());
        return list[0] ? { ...list[0] } : null;
      },
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("upload"), createdAt: new Date(), ...data };
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
          if (where.uploadId && entry.uploadId !== where.uploadId) continue;
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
      createMany: async ({ data }: { data: Row[] }) => {
        for (const row of data) {
          const id = nextId("match");
          matches.set(id, { id, createdAt: new Date(), updatedAt: new Date(), ...row });
        }
        return { count: data.length };
      },
      create: async ({ data }: { data: Row }) => {
        const id = nextId("match");
        const row = { id, createdAt: new Date(), updatedAt: new Date(), ...data };
        matches.set(id, row);
        return { ...row };
      },
      deleteMany: async ({ where }: { where: Row }) => {
        const conditions = (where.OR as Row[] | undefined) ?? [where];
        const matchesCond = (row: Row, cond: Row) => {
          if (cond.entryId && (cond.entryId as Row).in) return (((cond.entryId as Row).in) as string[]).includes(row.entryId as string);
          if (cond.entryId) return row.entryId === cond.entryId;
          if (cond.personId && (cond.personId as Row).in) return (((cond.personId as Row).in) as string[]).includes(row.personId as string);
          if (cond.personId) return row.personId === cond.personId;
          return false;
        };
        let removed = 0;
        for (const [id, row] of [...matches.entries()]) {
          if (conditions.some((cond) => matchesCond(row, cond))) { matches.delete(id); removed += 1; }
        }
        return { count: removed };
      },
      count: async ({ where }: { where?: { entry?: Row } } = {}) => {
        let list = [...matches.values()];
        if (where?.entry) list = list.filter((match) => { const entry = entries.get(match.entryId as string); return entry ? entryFilter(entry, where.entry!) : false; });
        return list.length;
      },
    },
    backgroundCheckReview: {
      findMany: async () => [...reviews.values()].sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime())
        .map((review) => ({ ...review, entry: { ...entries.get(review.entryId as string) } })),
      findUnique: async ({ where }: { where: { id: string } }) => {
        const review = reviews.get(where.id);
        if (!review) return null;
        return { ...review, entry: { ...entries.get(review.entryId as string) } };
      },
      createMany: async ({ data }: { data: Row[] }) => {
        for (const row of data) {
          const id = nextId("review");
          reviews.set(id, { id, createdAt: new Date(), ...row });
        }
        return { count: data.length };
      },
      deleteMany: async ({ where }: { where: Row }) => {
        let removed = 0;
        for (const [id, review] of [...reviews.entries()]) {
          if (where.entryId && (where.entryId as Row).in && !(((where.entryId as Row).in) as string[]).includes(review.entryId as string)) continue;
          if (where.entryId && typeof where.entryId === "string" && review.entryId !== where.entryId) continue;
          reviews.delete(id);
          removed += 1;
        }
        return { count: removed };
      },
      count: async () => reviews.size,
    },
    externalIdentity: {
      findMany: async ({ where }: { where: Row }) => {
        let list = [...identities.values()];
        const externalId = where.externalId as { in: string[] } | undefined;
        if (externalId) list = list.filter((identity) => externalId.in.includes(identity.externalId as string));
        if (where.provider) list = list.filter((identity) => identity.provider === where.provider);
        if (where.providerScope !== undefined) list = list.filter((identity) => identity.providerScope === where.providerScope);
        return list.map((identity) => ({ ...identity, person: identity.personId ? persons.get(identity.personId as string) ?? null : null }));
      },
      deleteMany: async ({ where }: { where: Row }) => {
        let removed = 0;
        for (const [id, identity] of [...identities.entries()]) {
          if (where.provider && identity.provider !== where.provider) continue;
          if (where.personId && identity.personId !== where.personId) continue;
          const not = where.NOT as { externalId?: string } | undefined;
          if (not?.externalId && identity.externalId === not.externalId) continue;
          identities.delete(id);
          removed += 1;
        }
        return { count: removed };
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
  };
  (client as { $transaction?: unknown }).$transaction = async (work: (tx: typeof client) => Promise<unknown>) => work(client);

  return { client, seed: { persons, uploads, entries, matches, reviews, identities, rosterMembers, attendees, events } };
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
  clubComplianceReminderCounts,
  clubPortalComplianceReminderCounts,
  clubPortalComplianceStatuses,
  clubRosterComplianceStatuses,
  listBackgroundCheckReviews,
  listEventBackgroundFlags,
  listUnmatchedBackgroundCheckEntries,
  planBackgroundCheckUpload,
  refreshBackgroundCheckMatchForPerson,
  resolveBackgroundCheckReview,
} from "@/modules/background-checks/repository";
import { clubCapabilities } from "@/modules/organizations/director-grants-domain";

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
  it("keeps a clear Sterling row dated, and marks a non-clear one not in compliance instead of dropping it", () => {
    const [clearRow] = parseSterlingCsv("First name,Last name,Email,Expiration date,Status\nAna,Rivera,ana@example.test,2029-01-01,Clear");
    const clear = sterlingRowToListRow(clearRow!);
    expect(clear).toMatchObject({ complianceStatus: null, expiresOn: "2029-01-01", issuesNote: null });

    const [flaggedRow] = parseSterlingCsv("First name,Last name,Email,Expiration date,Status\nBo,Lee,bo@example.test,2029-01-01,Needs review");
    const flagged = sterlingRowToListRow(flaggedRow!);
    expect(flagged).toMatchObject({ complianceStatus: "NOT_COMPLIANT", expiresOn: null, issuesNote: "Sterling status: Needs review." });
  });

  it("builds a stable identity key: user_id first, then email, then birth date, then site, then name", () => {
    const normalizedName = matchableName("Ana Rivera");
    expect(backgroundCheckIdentityKey({ sourceUserId: "9001", normalizedName, email: "ana@example.test", birthDate: "1985-01-01", site: "Test Church" }))
      .toBe("userId:9001");
    expect(backgroundCheckIdentityKey({ sourceUserId: null, normalizedName, email: "ana@example.test", birthDate: "1985-01-01", site: "Test Church" }))
      .toBe("email:ana@example.test");
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
    await expect(planBackgroundCheckUpload(rows)).resolves.toEqual({ added: 1, changed: 0, dropped: 0, total: 1 });
  });

  it("counts added, changed, and dropped against what's already on file", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    const uploadId = "upload-1";
    seed.uploads.set(uploadId, { id: uploadId, createdAt: new Date("2026-09-01") });
    seed.entries.set("e-kept", { id: "e-kept", uploadId, identityKey: "email:ana@example.test", firstName: "Ana", lastName: "Rivera", email: "ana@example.test", sealedBirthDate: null, site: null, sourceUserId: null, complianceStatus: null, checkedOn: null, expiresOn: "2029-01-01", issuesNote: null });
    seed.entries.set("e-dropped", { id: "e-dropped", uploadId, identityKey: "email:bo@example.test", firstName: "Bo", lastName: "Lee", email: "bo@example.test", sealedBirthDate: null, site: null, sourceUserId: null, complianceStatus: null, checkedOn: null, expiresOn: "2029-01-01", issuesNote: null });

    const rows = [
      sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nAna,Rivera,ana@example.test,2030-01-01")[0]!), // same identity, new date -> changed
      sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nKim,Cho,kim@example.test,2029-01-01")[0]!), // new -> added
    ];
    const counts = await planBackgroundCheckUpload(rows);
    expect(counts).toEqual({ added: 1, changed: 1, dropped: 1, total: 2 });
  });

  it("the later row wins when an upload's own rows share an identity key", async () => {
    const rows = [
      sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nAna,Rivera,ana@example.test,2028-01-01")[0]!),
      sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nAna,Rivera,ana@example.test,2029-01-01")[0]!),
    ];
    const counts = await planBackgroundCheckUpload(rows);
    expect(counts.total).toBe(1);
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

describe("refreshBackgroundCheckMatchForPerson: matched without a re-upload (#527)", () => {
  it("a person added to a roster after an upload is matched right away", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    // The upload happens first, with no one on file yet to match "Ana Rivera" to.
    const rows = [sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nAna,Rivera,ana@example.test,2029-01-01")[0]!)];
    await applyBackgroundCheckUpload(rows, "STERLING", "admin-1", new Date("2026-09-28T12:00:00Z"));
    expect(seed.matches.size).toBe(0);

    // Ana is added to a club roster afterward.
    seed.persons.set("p-ana", { id: "p-ana", firstName: "Ana", lastName: "Rivera" });
    seed.rosterMembers.push({
      id: "rm-1", personId: "p-ana", organizationId: "org-1", clubYear: "2026-27", status: "ACTIVE", attendeeType: "ADULT", sealedBirthDate: null,
      person: { firstName: "Ana", lastName: "Rivera", normalizedEmail: "ana@example.test", attendeeAccountLinks: [] },
      organization: { name: "Test Pathfinders", parentOrganization: null },
    });

    await refreshBackgroundCheckMatchForPerson("p-ana", new Date("2026-09-29T12:00:00Z"));

    const matches = [...seed.matches.values()];
    expect(matches).toEqual([expect.objectContaining({ personId: "p-ana", matchedBy: "AUTO" })]);
  });

  it("clears a stale match when a person's name change no longer matches their old entry", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    seed.persons.set("p-ana", { id: "p-ana", firstName: "Ana", lastName: "Rivera" });
    seed.entries.set("e-1", {
      id: "e-1", uploadId: "u-1", identityKey: "email:ana@example.test", firstName: "Ana", lastName: "Rivera",
      normalizedName: matchableName("Ana Rivera"), email: "ana@example.test", sealedBirthDate: null, site: null, sourceUserId: null,
      complianceStatus: null, checkedOn: null, expiresOn: "2029-01-01", issuesNote: null,
    });
    seed.matches.set("m-1", { id: "m-1", personId: "p-ana", entryId: "e-1", matchedBy: "AUTO", createdAt: new Date(), updatedAt: new Date() });

    // Renamed — no roster/registration candidate any more under the new name, and no entry shares it either.
    seed.persons.set("p-ana", { id: "p-ana", firstName: "Anna", lastName: "Riveraz" });
    await refreshBackgroundCheckMatchForPerson("p-ana", new Date("2026-09-29T12:00:00Z"));
    expect(seed.matches.size).toBe(0);
  });
});

describe("staff review resolution (#527)", () => {
  it("remembers a manual match so it holds on the next upload", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    seed.persons.set("p-kim-1", { id: "p-kim-1", firstName: "Kim", lastName: "Cho" });
    seed.persons.set("p-kim-2", { id: "p-kim-2", firstName: "Kim", lastName: "Cho" });
    seed.uploads.set("u-1", { id: "u-1", createdAt: new Date("2026-09-01") });
    seed.entries.set("e-1", {
      id: "e-1", uploadId: "u-1", identityKey: "email:kim@example.test", firstName: "Kim", lastName: "Cho",
      normalizedName: matchableName("Kim Cho"), email: "kim@example.test", sealedBirthDate: null, site: null, sourceUserId: null,
      complianceStatus: null, checkedOn: null, expiresOn: "2029-01-01", issuesNote: null,
    });
    seed.reviews.set("r-1", { id: "r-1", entryId: "e-1", reason: "More than one person matches.", candidatePersonIds: ["p-kim-1", "p-kim-2"], createdAt: new Date() });

    await resolveBackgroundCheckReview("r-1", { type: "match", personId: "p-kim-1" }, "admin-1");

    expect(seed.reviews.size).toBe(0);
    expect([...seed.matches.values()]).toEqual([expect.objectContaining({ personId: "p-kim-1", entryId: "e-1", matchedBy: "MANUAL" })]);
    const identity = [...seed.identities.values()].find((row) => row.externalId === "email:kim@example.test");
    expect(identity).toMatchObject({ personId: "p-kim-1", provider: "ROSTER_IMPORT" });

    // The next upload's row for the same entry now matches by the remembered identity.
    seed.persons.set("p-kim-1", { id: "p-kim-1", firstName: "Kim", lastName: "Cho" });
    const rows = [sterlingRowToListRow(parseSterlingCsv("First name,Last name,Email,Expiration date\nKim,Cho,kim@example.test,2030-01-01")[0]!)];
    await applyBackgroundCheckUpload(rows, "STERLING", "admin-1", new Date("2026-10-01T12:00:00Z"));
    const finalMatches = [...seed.matches.values()];
    expect(finalMatches).toEqual([expect.objectContaining({ personId: "p-kim-1", matchedBy: "IDENTITY" })]);
  });

  it("a dismissal clears the review without remembering anything", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    seed.entries.set("e-1", { id: "e-1", uploadId: "u-1", identityKey: "email:kim@example.test", firstName: "Kim", lastName: "Cho", normalizedName: matchableName("Kim Cho"), email: "kim@example.test", sealedBirthDate: null, site: null, sourceUserId: null, complianceStatus: null, checkedOn: null, expiresOn: null, issuesNote: null });
    seed.reviews.set("r-1", { id: "r-1", entryId: "e-1", reason: "Ambiguous.", candidatePersonIds: ["p-a", "p-b"], createdAt: new Date() });
    await resolveBackgroundCheckReview("r-1", { type: "dismiss" }, "admin-1");
    expect(seed.reviews.size).toBe(0);
    expect(seed.matches.size).toBe(0);
    expect(seed.identities.size).toBe(0);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "BACKGROUND_CHECK_REVIEW_DISMISSED" }), client);
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
    seed.rosterMembers.push(member("member-1", { complianceStatus: "NOT_COMPLIANT", expiresOn: null, issuesNote: "Pending paperwork" }));
    const forClub = await clubRosterComplianceStatuses("org-1", "2026", { includeNotes: false });
    expect(forClub.statuses["member-1"]).toEqual({ state: "NOT_COMPLIANT", note: null });
    expect(JSON.stringify(forClub)).not.toContain("Pending paperwork");
    const forStaff = await clubRosterComplianceStatuses("org-1", "2026", { includeNotes: true });
    expect(forStaff.statuses["member-1"]).toEqual({ state: "NOT_COMPLIANT", note: "Pending paperwork" });
  });

  it("shows a club's own roster the status for directors and deputies only, never a registrar, and never the note", async () => {
    const { client, seed } = makeFakeDb();
    currentClient = client;
    seed.rosterMembers.push(member("member-1", { complianceStatus: "FLAGGED", expiresOn: null, issuesNote: "Training expires 2026-11-01" }));
    await expect(clubPortalComplianceStatuses("org-1", "2026", clubCapabilities("REGISTRAR"))).resolves.toBeUndefined();
    for (const role of ["DIRECTOR", "DEPUTY"] as const) {
      await expect(clubPortalComplianceStatuses("org-1", "2026", clubCapabilities(role))).resolves.toEqual({ "member-1": { state: "FLAGGED", note: null } });
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
      attendee("roster-no", { complianceStatus: "NOT_COMPLIANT", expiresOn: null }),
      attendee("none", null),
    );
    const flags = await listEventBackgroundFlags("event-1");
    expect(flags?.adults).toBe(4);
    expect(flags?.people.map((flag) => [flag.attendeeId, flag.state])).toEqual([["roster-no", "NOT_COMPLIANT"], ["none", "MISSING"]]);
    expect(backgroundFlagsCsv(flags!.people)).toContain("Not in compliance");
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
