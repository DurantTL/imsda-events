import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  personFindMany: vi.fn(),
  checkFindMany: vi.fn(),
  checkUpsert: vi.fn(),
  eventFindUnique: vi.fn(),
  attendeeFindMany: vi.fn(),
  rosterFindMany: vi.fn(),
  writeAuditLog: vi.fn(),
  externalIdentityFindMany: vi.fn(),
  externalIdentityUpdateMany: vi.fn(),
  externalIdentityCreateMany: vi.fn(),
  checkCount: vi.fn(),
  checkFindFirst: vi.fn(),
  eventFindMany: vi.fn(),
}));

const client = {
  person: { findMany: mocks.personFindMany },
  backgroundCheck: { findMany: mocks.checkFindMany, upsert: mocks.checkUpsert, count: mocks.checkCount, findFirst: mocks.checkFindFirst },
  event: { findUnique: mocks.eventFindUnique, findMany: mocks.eventFindMany },
  registrationAttendee: { findMany: mocks.attendeeFindMany },
  clubRosterMember: { findMany: mocks.rosterFindMany },
  externalIdentity: { findMany: mocks.externalIdentityFindMany, updateMany: mocks.externalIdentityUpdateMany, createMany: mocks.externalIdentityCreateMany },
  $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/club-rosters/birth-dates", () => ({ openBirthDate: (sealed: string) => sealed.replace("sealed:", "") }));

import {
  attendeeIsAdult,
  backgroundCheckState,
  backgroundFlagsCsv,
  clubComplianceState,
  detectBackgroundCsvFormat,
  isClearStatus,
  matchableName,
  normalizeCheckDate,
  parseRosterBackgroundCsv,
  parseSterlingCsv,
  RosterBackgroundCsvError,
  SterlingCsvError,
} from "@/modules/background-checks/domain";
import {
  applyRosterBackgroundImport,
  applySterlingImport,
  backgroundCheckSummary,
  clubPortalComplianceStatuses,
  clubRosterComplianceStatuses,
  listEventBackgroundFlags,
  planRosterBackgroundImport,
  planSterlingImport,
  RosterImportSaveError,
} from "@/modules/background-checks/repository";
import { clubCapabilities } from "@/modules/organizations/director-grants-domain";

function person(id: string, options: { email?: string; birthDate?: string } = {}) {
  return {
    id,
    normalizedEmail: options.email ?? null,
    attendeeAccountLinks: [],
    registrationEvents: [],
    clubRosterMemberships: options.birthDate ? [{ sealedBirthDate: `sealed:${options.birthDate}` }] : [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkFindMany.mockResolvedValue([]);
  mocks.rosterFindMany.mockResolvedValue([]);
  mocks.attendeeFindMany.mockResolvedValue([]);
  mocks.externalIdentityFindMany.mockResolvedValue([]);
  mocks.externalIdentityUpdateMany.mockResolvedValue({ count: 1 });
  mocks.externalIdentityCreateMany.mockImplementation(({ data }: { data: unknown[] }) => Promise.resolve({ count: data.length }));
  mocks.checkFindFirst.mockResolvedValue(null);
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
    // An expiration of 6/30/28 must not become 1928 and read as long expired.
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

describe("matching an upload to people (#388)", () => {
  const csv = (...lines: string[]) => parseSterlingCsv(["First name,Last name,Email,Birth date,Expiration date,Status", ...lines].join("\n"));

  it("matches by name plus email or birth date, and reports rows it couldn't match", async () => {
    mocks.personFindMany.mockImplementation(async ({ where }: { where: { lastName: { equals: string } } }) => ({
      Rivera: [person("p-ana", { email: "ana@example.test" })],
      Lee: [person("p-sam", { birthDate: "1980-01-02" })],
      Cho: [person("p-kim-1", { email: "kim@example.test" }), person("p-kim-2", { email: "kim@example.test" })],
      Nobody: [],
      Moss: [person("p-jo", { email: "jo@example.test" })],
    } as Record<string, unknown[]>)[where.lastName.equals] ?? []);
    const steps = await planSterlingImport(csv(
      "Ana,Rivera,ana@example.test,,2029-09-01,Clear",
      "Sam,Lee,,1/2/1980,2029-09-01,",
      "Kim,Cho,kim@example.test,,2029-09-01,",
      "Pat,Nobody,pat@example.test,,2029-09-01,",
      "Jo,Moss,other@example.test,,2029-09-01,",
      "Lu,Moss,lu@example.test,,2029-09-01,Needs review",
    ));
    expect(steps.map((step) => [step.line, step.action, step.personId ?? null])).toEqual([
      [2, "ADD", "p-ana"],
      [3, "ADD", "p-sam"],
      [4, "SKIP", null],
      [5, "SKIP", null],
      [6, "SKIP", null],
      [7, "SKIP", null],
    ]);
    expect(steps[2]!.message).toMatch(/More than one person/);
    expect(steps[3]!.message).toMatch(/No one by this name/);
    expect(steps[4]!.message).toMatch(/didn't match/);
    expect(steps[5]!.message).toMatch(/not a clear check/);
  });

  it("keeps the later expiration when a person appears twice or is already on file", async () => {
    mocks.personFindMany.mockResolvedValue([person("p-ana", { email: "ana@example.test" })]);
    mocks.checkFindMany.mockResolvedValue([]);
    const twice = await planSterlingImport(csv(
      "Ana,Rivera,ana@example.test,,2028-01-01,",
      "Ana,Rivera,ana@example.test,,2029-01-01,",
    ));
    expect(twice.map((step) => step.action)).toEqual(["SKIP", "ADD"]);

    mocks.checkFindMany.mockResolvedValue([{ personId: "p-ana", expiresOn: "2030-01-01" }]);
    const older = await planSterlingImport(csv("Ana,Rivera,ana@example.test,,2029-01-01,"));
    expect(older[0]).toMatchObject({ action: "SKIP", message: "A check lasting at least as long is already on file." });

    mocks.checkFindMany.mockResolvedValue([{ personId: "p-ana", expiresOn: "2027-01-01" }]);
    const renewed = await planSterlingImport(csv("Ana,Rivera,ana@example.test,,2029-01-01,"));
    expect(renewed[0]).toMatchObject({ action: "UPDATE", personId: "p-ana" });
  });

  it("stores only the dates, audited without names", async () => {
    await applySterlingImport([
      { line: 2, name: "Ana Rivera", action: "ADD", message: "", personId: "p-ana", checkedOn: "2026-09-01", expiresOn: "2029-09-01" },
      { line: 3, name: "Pat Nobody", action: "SKIP", message: "No one by this name." },
    ], "admin-1");
    expect(mocks.checkUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.checkUpsert.mock.calls[0]![0]).toMatchObject({
      where: { personId: "p-ana" },
      update: { checkedOn: "2026-09-01", expiresOn: "2029-09-01", recordedByUserId: "admin-1" },
    });
    const audit = mocks.writeAuditLog.mock.calls[0]![0];
    expect(audit).toMatchObject({ action: "BACKGROUND_CHECKS_IMPORTED", metadata: { added: 1, updated: 0, skipped: 1 } });
    expect(JSON.stringify(audit)).not.toContain("Rivera");
  });
});

describe("flags at youth or children's events (#388)", () => {
  function attendee(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      personId: `person-${id}`,
      attendeeType: "Pathfinder",
      profileSnapshot: {},
      formResponses: {},
      person: { firstName: "Test", lastName: id, backgroundCheck: null },
      registration: { id: "reg-1", confirmationCode: "ABC123", clubRegistration: null },
      ...overrides,
    };
  }

  beforeEach(() => {
    mocks.eventFindUnique.mockResolvedValue({
      checksAdultBackgrounds: true,
      startsAt: new Date("2026-10-02T17:00:00Z"),
      endsAt: new Date("2026-10-04T17:00:00Z"),
      timezone: "America/Chicago",
    });
  });

  it("does nothing for events that don't check", async () => {
    mocks.eventFindUnique.mockResolvedValue({ checksAdultBackgrounds: false });
    await expect(listEventBackgroundFlags("event-1")).resolves.toBeNull();
    expect(mocks.attendeeFindMany).not.toHaveBeenCalled();
  });

  it("flags every adult without a check current through the last day, and no one else", async () => {
    mocks.rosterFindMany.mockResolvedValue([{ id: "roster-staff", attendeeType: "STAFF" }, { id: "roster-tlt", attendeeType: "STAFF" }]);
    mocks.attendeeFindMany.mockResolvedValue([
      attendee("club-staff", {
        attendeeType: "Staff",
        profileSnapshot: { clubRosterMemberId: "roster-staff", ageOnEventDate: 41 },
        registration: { id: "reg-club", confirmationCode: "CLUB1", clubRegistration: { organizationId: "club-1", organization: { name: "Test Pathfinders" } } },
      }),
      attendee("tlt-16", { attendeeType: "Staff", profileSnapshot: { clubRosterMemberId: "roster-tlt", ageOnEventDate: 16 } }),
      attendee("pathfinder", { profileSnapshot: { ageOnEventDate: 12 } }),
      attendee("parent", { attendeeType: "Parent", formResponses: { attendee_age: "38" } }),
      attendee("expired", { attendeeType: "Adult", person: { firstName: "Test", lastName: "expired", backgroundCheck: { expiresOn: "2026-10-03" } } }),
      attendee("current", { attendeeType: "Adult", person: { firstName: "Test", lastName: "current", backgroundCheck: { expiresOn: "2026-10-04" } } }),
      attendee("dob-adult", { formResponses: { date_of_birth: "2000-05-05" } }),
    ]);
    const flags = await listEventBackgroundFlags("event-1");
    expect(flags?.adults).toBe(5);
    expect(flags?.lastDay).toBe("2026-10-04");
    expect(flags?.people.map((flag) => [flag.attendeeId, flag.state])).toEqual([
      ["club-staff", "MISSING"],
      ["parent", "MISSING"],
      ["expired", "EXPIRED"],
      ["dob-adult", "MISSING"],
    ]);
    expect(flags?.people[0]).toMatchObject({ clubName: "Test Pathfinders", organizationId: "club-1" });
  });

  it("narrows to one club for event managers", async () => {
    mocks.attendeeFindMany.mockResolvedValue([]);
    await listEventBackgroundFlags("event-1", { organizationId: "club-1" });
    expect(mocks.attendeeFindMany.mock.calls[0]![0].where.registration).toMatchObject({ clubRegistration: { organizationId: "club-1" } });
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
    expect(rows[1]).not.toHaveProperty("active");
    expect(rows[2]).toMatchObject({ userId: "333333", compliance: "FLAGGED", issuesNote: "Training expires 2026-11-01", problems: [] });
    expect(rows[3]).toMatchObject({ compliance: "CLEAR", problems: [] });
    expect(rows[4]).toMatchObject({ compliance: "NOT_COMPLIANT", problems: [] });
    expect(rows[5]!.problems).toEqual(["A user_id is needed so this person is remembered next time.", 'compliance must be "y", "n", or "!".']);
  });

  it("treats any other compliance value, blank included, as a row problem, never a guess", () => {
    for (const value of ["maybe", "1", "true", "active", "0", "false", "flagged", ""]) {
      const [row] = rosterCsv(`444444,Doe,Jo,,,y,${value},`);
      expect(row!.compliance, value).toBeNull();
      expect(row!.problems, value).toEqual(['compliance must be "y", "n", or "!".']);
    }
  });

  it("explains a file it can't use", () => {
    expect(() => parseRosterBackgroundCsv("user_id,user_last,user_first\n1,A,B")).toThrow(RosterBackgroundCsvError);
    expect(() => parseRosterBackgroundCsv("user_last,user_first,compliance\nA,B,y")).toThrow(/user_id column/);
    expect(() => parseRosterBackgroundCsv("user_id,user_last,user_first\n1,A,B")).toThrow(/compliance column/);
  });

  it("detects the roster format on user_id alone, so a roster file missing a column gets the roster message", () => {
    expect(detectBackgroundCsvFormat("user_id,user_last,user_first\n1,A,B")).toBe("ROSTER");
    expect(detectBackgroundCsvFormat("User Id,Last,First,Compliance\n1,A,B,y")).toBe("ROSTER");
    expect(detectBackgroundCsvFormat("First name,Last name,Email,Expiration date\nA,B,a@example.test,2029-01-01")).toBe("STERLING");
  });

  it("rejects a file over 5,000 rows", () => {
    const header = "user_id,user_last,user_first,roles,sites,user_active,compliance,issues";
    const rows = Array.from({ length: 5_001 }, (_, index) => `${index},Lee,Person${index},,,y,y,`);
    expect(() => parseRosterBackgroundCsv([header, ...rows].join("\n"))).toThrow(/too many rows/);
    // Exactly the limit is fine.
    expect(parseRosterBackgroundCsv([header, ...rows.slice(0, 5_000)].join("\n"))).toHaveLength(5_000);
  });
});

type IdentityRow = { id: string; externalId: string; personId: string | null; person?: { firstName: string; lastName: string } | null };

/** The mocked ExternalIdentity table: filtered by externalId or personId like the real queries. */
function identities(rows: IdentityRow[]) {
  mocks.externalIdentityFindMany.mockImplementation(async ({ where }: { where: { externalId?: { in: string[] }; personId?: { in: string[] } } }) => rows.filter((row) => (
    (where.externalId ? where.externalId.in.includes(row.externalId) : true)
    && (where.personId ? row.personId !== null && where.personId.in.includes(row.personId) : true)
  )));
}

function rosterMember(personId: string, firstName: string, lastName: string, clubName: string, churchName: string | null = null) {
  return {
    personId,
    person: { firstName, lastName },
    organization: { name: clubName, parentOrganization: churchName ? { name: churchName } : null },
  };
}

const rosterImportCsv = (...rows: string[]) => parseRosterBackgroundCsv(
  ["user_id,user_last,user_first,roles,sites,user_active,compliance,issues", ...rows].join("\n"),
);

describe("matching a roster import to people (#427)", () => {
  it("normalizes case, spacing, and accents for name matching", () => {
    expect(matchableName("José  O'Brien")).toBe(matchableName("jose obrien"));
    expect(matchableName("  Ana   Rivera ")).toBe(matchableName("ANA RIVERA"));
    expect(matchableName("Café")).toBe("cafe");
  });

  it("tells two same-name people apart by their site", async () => {
    mocks.rosterFindMany.mockResolvedValue([
      rosterMember("p-north", "Lu", "Moss", "North Pathfinders", "North Church"),
      rosterMember("p-south", "Lu", "Moss", "South Pathfinders", "South Church"),
    ]);
    const steps = await planRosterBackgroundImport(rosterImportCsv("9001,Moss,Lu,Director,South Pathfinders,y,y,"));
    expect(steps).toEqual([expect.objectContaining({ action: "ADD", personId: "p-south" })]);
    expect(steps[0]!.message).toMatch(/name and location/);
  });

  it("also matches a sponsoring church, not just the club itself", async () => {
    mocks.rosterFindMany.mockResolvedValue([
      rosterMember("p-north", "Lu", "Moss", "North Pathfinders", "North Church"),
      rosterMember("p-south", "Lu", "Moss", "South Pathfinders", "South Church"),
    ]);
    const steps = await planRosterBackgroundImport(rosterImportCsv("9001,Moss,Lu,Director,North Church,y,y,"));
    expect(steps).toEqual([expect.objectContaining({ action: "ADD", personId: "p-north" })]);
  });

  it("leaves a row that stays ambiguous for review, with each candidate's full name and every site", async () => {
    mocks.rosterFindMany.mockResolvedValue([
      rosterMember("p-north", "Lu", "Moss", "North Pathfinders", "North Church"),
      rosterMember("p-south", "Lu", "Moss", "South Pathfinders"),
    ]);
    const noSite = await planRosterBackgroundImport(rosterImportCsv("9001,Moss,Lu,Director,,y,y,"));
    expect(noSite).toHaveLength(1);
    expect(noSite[0]!.action).toBe("REVIEW");
    expect(noSite[0]!.personId).toBeUndefined();
    expect(noSite[0]!.candidates).toEqual([
      { personId: "p-north", name: "Lu Moss", sites: ["North Pathfinders", "North Church"] },
      { personId: "p-south", name: "Lu Moss", sites: ["South Pathfinders"] },
    ]);

    const wrongSite = await planRosterBackgroundImport(rosterImportCsv("9001,Moss,Lu,Director,East Pathfinders,y,y,"));
    expect(wrongSite[0]).toMatchObject({ action: "REVIEW" });
    expect(wrongSite[0]!.message).toMatch(/didn't narrow/);
  });

  it("sends a single name match to review when sites isn't that person's club or church", async () => {
    mocks.rosterFindMany.mockResolvedValue([rosterMember("p-ana", "Ana", "Rivera", "Test Pathfinders", "Test Church")]);
    const [wrong] = await planRosterBackgroundImport(rosterImportCsv("1,Rivera,Ana,,Other Church,y,y,"));
    expect(wrong).toMatchObject({ action: "REVIEW", candidates: [{ personId: "p-ana", name: "Ana Rivera", sites: ["Test Pathfinders", "Test Church"] }] });
    expect(wrong!.personId).toBeUndefined();
    expect(wrong!.message).toMatch(/isn't their club or church/);

    const [right] = await planRosterBackgroundImport(rosterImportCsv("1,Rivera,Ana,,test church,y,y,"));
    expect(right).toMatchObject({ action: "ADD", personId: "p-ana" });
    const [blank] = await planRosterBackgroundImport(rosterImportCsv("1,Rivera,Ana,,,y,y,"));
    expect(blank).toMatchObject({ action: "ADD", personId: "p-ana", message: "Matched by name. Clear." });
  });

  it("reports a name that matches no one, and a malformed row, as not found", async () => {
    const steps = await planRosterBackgroundImport(rosterImportCsv("9001,Nobody,Pat,,,y,y,", ",Blank,User,,,y,y,"));
    expect(steps.map((step) => step.action)).toEqual(["SKIP", "SKIP"]);
    expect(steps[0]!.message).toMatch(/No one by this name/);
  });

  it("matches by the remembered user_id first when the name agrees", async () => {
    identities([{ id: "ei-1", externalId: "9001", personId: "p-south", person: { firstName: "Lu", lastName: "Moss" } }]);
    const steps = await planRosterBackgroundImport(rosterImportCsv("9001,MOSS,Lu,Director,,n,n,Left the club"));
    expect(steps).toEqual([expect.objectContaining({ action: "ADD", personId: "p-south", message: expect.stringMatching(/remembered user_id/) })]);
    expect(mocks.externalIdentityFindMany.mock.calls[0]![0]).toMatchObject({
      where: { provider: "ROSTER_IMPORT", providerScope: "", externalId: { in: ["9001"] } },
    });
  });

  it("sends a remembered user_id whose name doesn't match to review, naming who it belongs to", async () => {
    mocks.rosterFindMany.mockResolvedValue([rosterMember("p-ana", "Ana", "Rivera", "Test Pathfinders")]);
    identities([{ id: "ei-1", externalId: "9001", personId: "p-lu", person: { firstName: "Lu", lastName: "Moss" } }]);
    const [step] = await planRosterBackgroundImport(rosterImportCsv("9001,Rivera,Ana,,,y,y,"));
    expect(step).toMatchObject({ action: "REVIEW", message: expect.stringContaining("user_id 9001 belongs to Lu Moss") });
    expect(step!.personId).toBeUndefined();
    expect(step!.candidates).toEqual([{ personId: "p-lu", name: "Lu Moss", sites: [] }]);
  });

  it("sends every row to review when the file gives one user_id to different people", async () => {
    mocks.rosterFindMany.mockResolvedValue([
      rosterMember("p-ana", "Ana", "Rivera", "Test Pathfinders"),
      rosterMember("p-sam", "Sam", "Lee", "Test Pathfinders"),
    ]);
    const steps = await planRosterBackgroundImport(rosterImportCsv("7,Rivera,Ana,,,y,y,", "7,Lee,Sam,,,y,n,"));
    expect(steps.map((step) => step.action)).toEqual(["REVIEW", "REVIEW"]);
    expect(steps[0]!.message).toMatch(/more than one row in this file/);
    expect(steps[0]!.candidates?.map((candidate) => candidate.personId).sort()).toEqual(["p-ana", "p-sam"]);
    expect(steps.every((step) => step.personId === undefined)).toBe(true);
  });

  it("sends every row to review when different user_ids in the file match the same person", async () => {
    mocks.rosterFindMany.mockResolvedValue([rosterMember("p-ana", "Ana", "Rivera", "Test Pathfinders", "Test Church")]);
    const steps = await planRosterBackgroundImport(rosterImportCsv(
      "11,Rivera,Ana,,,y,n,",
      "12,Rivera,Ana,,Test Church,y,y,",
      "13,Rivera,Ana,,Test Pathfinders,y,!,",
    ));
    expect(steps.map((step) => step.action)).toEqual(["REVIEW", "REVIEW", "REVIEW"]);
    expect(steps[0]!.message).toMatch(/Also matched by user_id 12, 13/);
    expect(steps[1]!.message).toMatch(/Also matched by user_id 11, 13/);
    expect(steps[2]!.candidates).toEqual([{ personId: "p-ana", name: "Ana Rivera", sites: ["Test Pathfinders", "Test Church"] }]);
    expect(steps.every((step) => step.personId === undefined)).toBe(true);
    expect(mocks.checkFindMany).not.toHaveBeenCalled();
  });

  it("sends a person already remembered under a different user_id to review", async () => {
    mocks.rosterFindMany.mockResolvedValue([rosterMember("p-ana", "Ana", "Rivera", "Test Pathfinders")]);
    identities([{ id: "ei-1", externalId: "1", personId: "p-ana", person: { firstName: "Ana", lastName: "Rivera" } }]);
    const [step] = await planRosterBackgroundImport(rosterImportCsv("2,Rivera,Ana,,,y,y,"));
    expect(step).toMatchObject({ action: "REVIEW", message: expect.stringContaining("already remembered under user_id 1") });
  });

  it("keeps only the later row for the same matched person, and marks ADD vs UPDATE from what's on file", async () => {
    mocks.rosterFindMany.mockResolvedValue([rosterMember("p-ana", "Ana", "Rivera", "Test Pathfinders")]);
    const twice = await planRosterBackgroundImport(rosterImportCsv("1,Rivera,Ana,,,y,y,", "1,Rivera,Ana,,,y,!,Renewal due"));
    expect(twice.map((step) => step.action)).toEqual(["SKIP", "ADD"]);
    expect(twice[1]!.message).toBe("Matched by name. Expiring soon.");

    mocks.checkFindMany.mockResolvedValue([{ personId: "p-ana" }]);
    const update = await planRosterBackgroundImport(rosterImportCsv("1,Rivera,Ana,,,y,y,"));
    expect(update[0]).toMatchObject({ action: "UPDATE", personId: "p-ana" });
  });

  it("carries the note through on every row, matched, review, and not-found alike", async () => {
    mocks.rosterFindMany.mockResolvedValue([
      rosterMember("p-ana", "Ana", "Rivera", "Test Pathfinders"),
      rosterMember("p-north", "Lu", "Moss", "North Pathfinders"),
      rosterMember("p-south", "Lu", "Moss", "South Pathfinders"),
    ]);
    const steps = await planRosterBackgroundImport(rosterImportCsv(
      "1,Rivera,Ana,,,y,y,All clear",
      "2,Nobody,Pat,,,y,y,Left the church",
      "3,Moss,Lu,,,y,y,Ambiguous name",
    ));
    expect(steps.find((step) => step.name === "Ana Rivera")).toMatchObject({ action: "ADD", issuesNote: "All clear" });
    expect(steps.find((step) => step.name === "Pat Nobody")).toMatchObject({ action: "SKIP", issuesNote: "Left the church" });
    expect(steps.find((step) => step.name === "Lu Moss")).toMatchObject({ action: "REVIEW", issuesNote: "Ambiguous name" });
  });

  it("indexes registered adults only for events upcoming or ended in the last 12 months", async () => {
    await planRosterBackgroundImport(rosterImportCsv("1,Rivera,Ana,,,y,y,"), new Date("2026-09-25T12:00:00Z"));
    const query = mocks.attendeeFindMany.mock.calls[0]![0];
    expect(query.where.event).toEqual({ endsAt: { gte: new Date("2025-09-25T12:00:00Z") } });
    expect(Object.keys(query.select).sort()).toEqual(["attendeeType", "formResponses", "person", "personId", "profileSnapshot", "registration"]);
  });
});

describe("saving a roster import (#427)", () => {
  function saveStep(line: number, personId: string, userId: string, compliance: "CLEAR" | "FLAGGED" | "NOT_COMPLIANT" = "CLEAR", issuesNote: string | null = null) {
    return { line, name: `Person ${line}`, action: "ADD" as const, message: "", personId, userId, compliance, issuesNote };
  }

  it("records compliance (including expiring soon), clears Sterling's dates, and remembers new user_ids", async () => {
    const result = await applyRosterBackgroundImport([
      saveStep(2, "p-ana", "1"),
      { ...saveStep(3, "p-sam", "2", "NOT_COMPLIANT", "Check expired 2026-08-01"), action: "UPDATE" },
      saveStep(4, "p-kim", "3", "FLAGGED", "Training expires 2026-11-01"),
      { line: 5, name: "Pat Nobody", action: "SKIP", message: "No one by this name." },
      { line: 6, name: "Lu Moss", action: "REVIEW", message: "More than one person has this name.", candidates: [{ personId: "p-a", name: "Lu Moss", sites: [] }] },
    ], "admin-1");

    expect(result).toMatchObject({ added: 2, updated: 1, batches: 1, idsNotRemembered: 0 });
    expect(mocks.checkUpsert).toHaveBeenCalledTimes(3);
    expect(mocks.checkUpsert.mock.calls[0]![0]).toEqual({
      where: { personId: "p-ana" },
      create: { personId: "p-ana", provider: "ROSTER_IMPORT", checkedOn: null, expiresOn: null, complianceStatus: "CLEAR", issuesNote: null, recordedByUserId: "admin-1" },
      update: { provider: "ROSTER_IMPORT", checkedOn: null, expiresOn: null, complianceStatus: "CLEAR", issuesNote: null, recordedByUserId: "admin-1" },
    });
    expect(mocks.checkUpsert.mock.calls[2]![0].update).toMatchObject({ complianceStatus: "FLAGGED", issuesNote: "Training expires 2026-11-01" });
    expect(mocks.externalIdentityCreateMany).toHaveBeenCalledTimes(1);
    expect(mocks.externalIdentityCreateMany.mock.calls[0]![0]).toMatchObject({
      skipDuplicates: true,
      data: [
        { personId: "p-ana", provider: "ROSTER_IMPORT", providerScope: "", externalId: "1" },
        { personId: "p-sam", provider: "ROSTER_IMPORT", providerScope: "", externalId: "2" },
        { personId: "p-kim", provider: "ROSTER_IMPORT", providerScope: "", externalId: "3" },
      ],
    });
    const audit = mocks.writeAuditLog.mock.calls[0]![0];
    expect(audit).toMatchObject({ action: "BACKGROUND_CHECKS_IMPORTED", metadata: { added: 2, updated: 1, review: 1, skipped: 1, recorded: 3, batch: 1, batches: 1 } });
    expect(JSON.stringify(audit)).not.toContain("Training expires");
  });

  it("attaches a user_id on file with no person instead of inserting a duplicate, and never takes one from someone else", async () => {
    identities([
      { id: "ei-orphan", externalId: "1", personId: null },
      { id: "ei-known", externalId: "2", personId: "p-sam" },
      { id: "ei-other", externalId: "3", personId: "p-someone-else" },
    ]);
    const result = await applyRosterBackgroundImport([
      saveStep(2, "p-ana", "1"),
      saveStep(3, "p-sam", "2"),
      saveStep(4, "p-kim", "3"),
    ], "admin-1");

    expect(mocks.externalIdentityUpdateMany).toHaveBeenCalledWith({
      where: { id: "ei-orphan", personId: null },
      data: { personId: "p-ana", lastVerifiedAt: expect.any(Date) },
    });
    expect(mocks.externalIdentityUpdateMany).toHaveBeenCalledWith({ where: { id: { in: ["ei-known"] } }, data: { lastVerifiedAt: expect.any(Date) } });
    expect(mocks.externalIdentityCreateMany).not.toHaveBeenCalled();
    expect(result.idsNotRemembered).toBe(1);
  });

  it("saves 5,000 planned rows in batches of 250, each with its own transaction and audit entry", async () => {
    const header = "user_id,user_last,user_first,roles,sites,user_active,compliance,issues";
    const csvRows = Array.from({ length: 5_000 }, (_, index) => `u${index},Last${index},First${index},,,y,${index % 3 === 0 ? "!" : "y"},`);
    mocks.rosterFindMany.mockResolvedValue(Array.from({ length: 5_000 }, (_, index) => rosterMember(`p-${index}`, `First${index}`, `Last${index}`, "Test Pathfinders")));
    const plan = await planRosterBackgroundImport(parseRosterBackgroundCsv([header, ...csvRows].join("\n")));
    expect(plan.filter((step) => step.action === "ADD")).toHaveLength(5_000);

    const transaction = vi.spyOn(client, "$transaction");
    const result = await applyRosterBackgroundImport(plan, "admin-1");
    expect(result).toMatchObject({ added: 5_000, batches: 20 });
    expect(transaction).toHaveBeenCalledTimes(20);
    expect((transaction.mock.calls[0] as unknown[])[1]).toEqual({ timeout: 60_000, maxWait: 10_000 });
    expect(mocks.checkUpsert).toHaveBeenCalledTimes(5_000);
    expect(mocks.writeAuditLog).toHaveBeenCalledTimes(20);
    expect(mocks.writeAuditLog.mock.calls[19]![0].metadata).toMatchObject({ batch: 20, batches: 20, recordedSoFar: 5_000 });
    transaction.mockRestore();
  });

  it("stops at a failed batch, keeps what was committed, and records how far it got", async () => {
    const steps = Array.from({ length: 600 }, (_, index) => saveStep(index + 2, `p-${index}`, `u${index}`));
    let calls = 0;
    const transaction = vi.spyOn(client, "$transaction").mockImplementation((async (work: (tx: unknown) => Promise<unknown>) => {
      calls += 1;
      if (calls === 2) throw new Error("synthetic timeout");
      return work(client);
    }) as never);
    const failure = await applyRosterBackgroundImport(steps, "admin-1").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RosterImportSaveError);
    expect(failure).toMatchObject({ saved: 250, total: 600 });
    expect(mocks.writeAuditLog.mock.calls.map((call) => call[0].action)).toEqual(["BACKGROUND_CHECKS_IMPORTED", "BACKGROUND_CHECKS_IMPORT_STOPPED"]);
    expect(mocks.writeAuditLog.mock.calls[1]![0].metadata).toMatchObject({ recorded: 250, toRecord: 600 });
    transaction.mockRestore();
  });
});

describe("the newest upload wins across Sterling and roster imports (#427)", () => {
  function attendee(id: string, backgroundCheck: unknown) {
    return {
      id,
      personId: `person-${id}`,
      attendeeType: "Adult",
      profileSnapshot: {},
      formResponses: {},
      person: { firstName: "Test", lastName: id, backgroundCheck },
      registration: { id: "reg-1", confirmationCode: "ABC123", clubRegistration: null },
    };
  }

  it("a Sterling upload after a roster import clears the compliance mark and note", async () => {
    await applySterlingImport([
      { line: 2, name: "Ana Rivera", action: "UPDATE", message: "", personId: "p-ana", checkedOn: "2026-09-01", expiresOn: "2029-09-01" },
    ], "admin-1");
    expect(mocks.checkUpsert.mock.calls[0]![0].update).toEqual({
      provider: "STERLING", checkedOn: "2026-09-01", expiresOn: "2029-09-01", complianceStatus: null, issuesNote: null, recordedByUserId: "admin-1",
    });
  });

  it("a Sterling preview replaces a roster-only row as an update, not an add", async () => {
    mocks.personFindMany.mockResolvedValue([person("p-ana", { email: "ana@example.test" })]);
    mocks.checkFindMany.mockResolvedValue([{ personId: "p-ana", expiresOn: null }]);
    const steps = await planSterlingImport(parseSterlingCsv("First name,Last name,Email,Expiration date\nAna,Rivera,ana@example.test,2029-01-01"));
    expect(steps[0]).toMatchObject({ action: "UPDATE", personId: "p-ana" });
  });

  it("says when a Sterling upload replaces a roster import's mark", async () => {
    mocks.checkFindMany.mockResolvedValue([{ personId: "p-ana", expiresOn: null, complianceStatus: "NOT_COMPLIANT" }]);
    const steps = await planSterlingImport(parseSterlingCsv("First name,Last name,Email,Expiration date\nAna,Rivera,ana@example.test,2029-01-01"));
    expect(steps[0]).toMatchObject({ action: "UPDATE", message: expect.stringContaining("Replaces the roster mark: Not in compliance.") });
  });

  it("counts a user_id another import saved first as not remembered", async () => {
    mocks.externalIdentityCreateMany.mockResolvedValue({ count: 0 });
    const result = await applyRosterBackgroundImport([
      { line: 2, name: "Ana Rivera", action: "ADD", message: "", personId: "p-ana", userId: "1", compliance: "CLEAR", issuesNote: null },
    ], "admin-1");
    expect(result).toMatchObject({ idsNotRemembered: 1 });
  });

  it("a roster import after Sterling clears the dates", async () => {
    await applyRosterBackgroundImport([
      { line: 2, name: "Ana Rivera", action: "UPDATE", message: "", personId: "p-ana", userId: "1", compliance: "NOT_COMPLIANT", issuesNote: null },
    ], "admin-1");
    expect(mocks.checkUpsert.mock.calls[0]![0].update).toMatchObject({ provider: "ROSTER_IMPORT", checkedOn: null, expiresOn: null, complianceStatus: "NOT_COMPLIANT" });
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
    expect(checks.map((check) => backgroundCheckState(check, today)))
      .toEqual(["CURRENT", "CURRENT", "NOT_COMPLIANT", "CURRENT", "CURRENT", "EXPIRED", "MISSING"]);
    // A Sterling check ending within 60 days reads as expiring soon on club pages, as on the summary.
    expect(checks.map((check) => clubComplianceState(check, today)))
      .toEqual(["CLEAR", "FLAGGED", "NOT_COMPLIANT", "CLEAR", "FLAGGED", "NOT_COMPLIANT", "NO_RECORD"]);
  });

  it("flags a roster-only Not in compliance adult at a youth event, but not a Clear or expiring-soon one", async () => {
    mocks.eventFindUnique.mockResolvedValue({
      checksAdultBackgrounds: true,
      startsAt: new Date("2026-10-02T17:00:00Z"),
      endsAt: new Date("2026-10-04T17:00:00Z"),
      timezone: "America/Chicago",
    });
    mocks.attendeeFindMany.mockResolvedValue([
      attendee("roster-clear", { complianceStatus: "CLEAR", expiresOn: null }),
      attendee("roster-soon", { complianceStatus: "FLAGGED", expiresOn: null }),
      attendee("roster-no", { complianceStatus: "NOT_COMPLIANT", expiresOn: null }),
      attendee("none", null),
    ]);
    const flags = await listEventBackgroundFlags("event-1");
    expect(flags?.adults).toBe(4);
    expect(flags?.people.map((flag) => [flag.attendeeId, flag.state])).toEqual([["roster-no", "NOT_COMPLIANT"], ["none", "MISSING"]]);
    expect(backgroundFlagsCsv(flags!.people)).toContain("Not in compliance");
  });

  it("counts both sources on the administrator's summary", async () => {
    mocks.checkCount.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      if (where.complianceStatus === null) {
        const expiresOn = where.expiresOn as { gte?: string; lte?: string; lt?: string };
        if (expiresOn.lt) return 1;
        return expiresOn.lte ? 2 : 5;
      }
      if (where.complianceStatus === "FLAGGED") return 3;
      if (where.complianceStatus === "NOT_COMPLIANT") return 4;
      return 10; // CLEAR or FLAGGED
    });
    mocks.eventFindMany.mockResolvedValue([]);
    const summary = await backgroundCheckSummary("2026-10-04");
    expect(summary).toMatchObject({ current: 15, expiringSoon: 5, notCurrent: 5 });
  });
});

describe("club page compliance (#427)", () => {
  it("counts not in compliance and expiring soon separately, and never counts No record", async () => {
    mocks.rosterFindMany.mockResolvedValue([
      { id: "member-clear", person: { backgroundCheck: { complianceStatus: "CLEAR", expiresOn: null, issuesNote: null } } },
      { id: "member-soon", person: { backgroundCheck: { complianceStatus: "FLAGGED", expiresOn: null, issuesNote: "Training expires 2026-11-01" } } },
      { id: "member-not-compliant", person: { backgroundCheck: { complianceStatus: "NOT_COMPLIANT", expiresOn: null, issuesNote: null } } },
      { id: "member-expired", person: { backgroundCheck: { complianceStatus: null, expiresOn: "2020-01-01", issuesNote: null } } },
      { id: "member-none", person: { backgroundCheck: null } },
    ]);

    const result = await clubRosterComplianceStatuses("org-1", "2026", { includeNotes: false });
    expect(Object.fromEntries(Object.entries(result.statuses).map(([id, status]) => [id, status.state]))).toEqual({
      "member-clear": "CLEAR",
      "member-soon": "FLAGGED",
      "member-not-compliant": "NOT_COMPLIANT",
      "member-expired": "NOT_COMPLIANT",
      "member-none": "NO_RECORD",
    });
    // "2 adults not in compliance · 1 expiring soon".
    expect(result.notInCompliance).toBe(2);
    expect(result.expiringSoon).toBe(1);
  });

  it("never includes the note unless the caller is allowed to see it", async () => {
    mocks.rosterFindMany.mockResolvedValue([
      { id: "member-1", person: { backgroundCheck: { complianceStatus: "NOT_COMPLIANT", expiresOn: null, issuesNote: "Pending paperwork" } } },
      { id: "member-2", person: { backgroundCheck: null } },
    ]);

    const forClub = await clubRosterComplianceStatuses("org-1", "2026", { includeNotes: false });
    expect(forClub.statuses["member-1"]).toEqual({ state: "NOT_COMPLIANT", note: null });
    expect(JSON.stringify(forClub)).not.toContain("Pending paperwork");

    const forStaff = await clubRosterComplianceStatuses("org-1", "2026", { includeNotes: true });
    expect(forStaff.statuses["member-1"]).toEqual({ state: "NOT_COMPLIANT", note: "Pending paperwork" });
    expect(forStaff.statuses["member-2"]).toEqual({ state: "NO_RECORD", note: null });
  });

  it("shows a club's own roster the status for directors and deputies only, never a registrar, and never the note", async () => {
    mocks.rosterFindMany.mockResolvedValue([
      { id: "member-1", person: { backgroundCheck: { complianceStatus: "FLAGGED", expiresOn: null, issuesNote: "Training expires 2026-11-01" } } },
    ]);
    await expect(clubPortalComplianceStatuses("org-1", "2026", clubCapabilities("REGISTRAR"))).resolves.toBeUndefined();
    expect(mocks.rosterFindMany).not.toHaveBeenCalled();
    for (const role of ["DIRECTOR", "DEPUTY"] as const) {
      await expect(clubPortalComplianceStatuses("org-1", "2026", clubCapabilities(role))).resolves.toEqual({
        "member-1": { state: "FLAGGED", note: null },
      });
    }
  });
});
