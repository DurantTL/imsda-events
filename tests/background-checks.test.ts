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
  externalIdentityUpsert: vi.fn(),
}));

const client = {
  person: { findMany: mocks.personFindMany },
  backgroundCheck: { findMany: mocks.checkFindMany, upsert: mocks.checkUpsert },
  event: { findUnique: mocks.eventFindUnique },
  registrationAttendee: { findMany: mocks.attendeeFindMany },
  clubRosterMember: { findMany: mocks.rosterFindMany },
  externalIdentity: { findMany: mocks.externalIdentityFindMany, upsert: mocks.externalIdentityUpsert },
  $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/club-rosters/birth-dates", () => ({ openBirthDate: (sealed: string) => sealed.replace("sealed:", "") }));

import {
  attendeeIsAdult,
  backgroundCheckState,
  clubComplianceState,
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
  clubRosterComplianceStatuses,
  listEventBackgroundFlags,
  planRosterBackgroundImport,
  planSterlingImport,
} from "@/modules/background-checks/repository";

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

  it("reads the real template and reports blank or invalid rows", () => {
    const rows = rosterCsv(
      "111111,Swanson,Joe,something,Church,y,y,notes",
      "222222,Lee,Sam,,,n,n,under review",
      ",Nobody,Pat,,,,,",
    );
    expect(rows[0]).toMatchObject({
      line: 2, userId: "111111", firstName: "Joe", lastName: "Swanson", roles: "something", site: "Church",
      active: true, compliant: true, issuesNote: "notes", problems: [],
    });
    expect(rows[1]).toMatchObject({ userId: "222222", active: false, compliant: false, site: null, problems: [] });
    expect(rows[2]!.problems).toEqual(["A user_id is needed so this person is remembered next time.", "compliance must be \"y\" or \"n\"."]);
  });

  it("explains a file it can't use", () => {
    expect(() => parseRosterBackgroundCsv("user_id,user_last,user_first\n1,A,B")).toThrow(RosterBackgroundCsvError);
    expect(() => parseRosterBackgroundCsv("user_last,user_first,compliance\nA,B,y")).toThrow(/user_id column/);
    expect(() => parseRosterBackgroundCsv("user_id,user_last,user_first\n1,A,B")).toThrow(/compliance column/);
  });

  it("rejects a file over 5,000 rows", () => {
    const header = "user_id,user_last,user_first,roles,sites,user_active,compliance,issues";
    const rows = Array.from({ length: 5_001 }, (_, index) => `${index},Lee,Person${index},,,y,y,`);
    expect(() => parseRosterBackgroundCsv([header, ...rows].join("\n"))).toThrow(/too many rows/);
    // Exactly the limit is fine.
    expect(parseRosterBackgroundCsv([header, ...rows.slice(0, 5_000)].join("\n"))).toHaveLength(5_000);
  });
});

describe("matching a roster import to people (#427)", () => {
  function rosterMember(personId: string, firstName: string, lastName: string, clubName: string, churchName: string | null = null) {
    return {
      personId,
      person: { firstName, lastName },
      organization: { name: clubName, parentOrganization: churchName ? { name: churchName } : null },
    };
  }

  const rosterCsv = (...rows: string[]) => parseRosterBackgroundCsv(
    ["user_id,user_last,user_first,roles,sites,user_active,compliance,issues", ...rows].join("\n"),
  );

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
    const steps = await planRosterBackgroundImport(rosterCsv(
      "9001,Moss,Lu,Director,South Pathfinders,y,y,",
    ));
    expect(steps).toEqual([expect.objectContaining({ action: "ADD", personId: "p-south" })]);
    expect(steps[0]!.message).toMatch(/name and location/);
  });

  it("also breaks a tie against a sponsoring church, not just the club itself", async () => {
    mocks.rosterFindMany.mockResolvedValue([
      rosterMember("p-north", "Lu", "Moss", "North Pathfinders", "North Church"),
      rosterMember("p-south", "Lu", "Moss", "South Pathfinders", "South Church"),
    ]);
    const steps = await planRosterBackgroundImport(rosterCsv("9001,Moss,Lu,Director,North Church,y,y,"));
    expect(steps).toEqual([expect.objectContaining({ action: "ADD", personId: "p-north" })]);
  });

  it("leaves a row that stays ambiguous for review, with its candidates, and never guesses", async () => {
    mocks.rosterFindMany.mockResolvedValue([
      rosterMember("p-north", "Lu", "Moss", "North Pathfinders"),
      rosterMember("p-south", "Lu", "Moss", "South Pathfinders"),
    ]);
    const noSite = await planRosterBackgroundImport(rosterCsv("9001,Moss,Lu,Director,,y,y,"));
    expect(noSite).toHaveLength(1);
    expect(noSite[0]!.action).toBe("REVIEW");
    expect(noSite[0]!.personId).toBeUndefined();
    expect(noSite[0]!.candidates?.map((candidate) => candidate.personId).sort()).toEqual(["p-north", "p-south"]);

    const wrongSite = await planRosterBackgroundImport(rosterCsv("9001,Moss,Lu,Director,East Pathfinders,y,y,"));
    expect(wrongSite[0]).toMatchObject({ action: "REVIEW" });
    expect(wrongSite[0]!.message).toMatch(/didn't narrow/);
  });

  it("reports a name that matches no one, and a malformed row, as not found", async () => {
    mocks.rosterFindMany.mockResolvedValue([]);
    const steps = await planRosterBackgroundImport(rosterCsv(
      "9001,Nobody,Pat,,,y,y,",
      ",Blank,User,,,y,y,",
    ));
    expect(steps.map((step) => step.action)).toEqual(["SKIP", "SKIP"]);
    expect(steps[0]!.message).toMatch(/No one by this name/);
  });

  it("matches by the remembered user_id first, even when the name index would say otherwise", async () => {
    mocks.rosterFindMany.mockResolvedValue([]); // Nobody by this name on file anymore.
    mocks.externalIdentityFindMany.mockResolvedValue([{ externalId: "9001", personId: "p-south" }]);
    const steps = await planRosterBackgroundImport(rosterCsv("9001,Moss,Lu,Director,,n,n,Left the club"));
    expect(steps).toEqual([expect.objectContaining({ action: "ADD", personId: "p-south", message: expect.stringMatching(/remembered user_id/) })]);
    expect(mocks.externalIdentityFindMany.mock.calls[0]![0]).toMatchObject({
      where: { provider: "ROSTER_IMPORT", providerScope: "", externalId: { in: ["9001"] } },
    });
  });

  it("keeps only the later row for the same matched person, and marks ADD vs UPDATE from what's on file", async () => {
    mocks.rosterFindMany.mockResolvedValue([rosterMember("p-ana", "Ana", "Rivera", "Test Pathfinders")]);
    mocks.checkFindMany.mockResolvedValue([]);
    const twice = await planRosterBackgroundImport(rosterCsv(
      "1,Rivera,Ana,,,y,y,",
      "1,Rivera,Ana,,,y,n,Renewed",
    ));
    expect(twice.map((step) => step.action)).toEqual(["SKIP", "ADD"]);

    mocks.checkFindMany.mockResolvedValue([{ personId: "p-ana" }]);
    const update = await planRosterBackgroundImport(rosterCsv("1,Rivera,Ana,,,y,y,"));
    expect(update[0]).toMatchObject({ action: "UPDATE", personId: "p-ana" });
  });

  it("records compliance and remembers the user_id, without touching skipped or review rows", async () => {
    await applyRosterBackgroundImport([
      { line: 2, name: "Ana Rivera", action: "ADD", message: "", personId: "p-ana", userId: "1", compliant: true, active: true, issuesNote: null },
      { line: 3, name: "Sam Lee", action: "UPDATE", message: "", personId: "p-sam", userId: "2", compliant: false, active: false, issuesNote: "Under review" },
      { line: 4, name: "Pat Nobody", action: "SKIP", message: "No one by this name." },
      { line: 5, name: "Lu Moss", action: "REVIEW", message: "More than one person has this name.", candidates: [{ personId: "p-a", site: null }] },
    ], "admin-1");

    expect(mocks.checkUpsert).toHaveBeenCalledTimes(2);
    expect(mocks.checkUpsert.mock.calls[0]![0]).toMatchObject({
      where: { personId: "p-ana" },
      create: { personId: "p-ana", provider: "ROSTER_IMPORT", complianceStatus: "CLEAR", issuesNote: null, active: true, recordedByUserId: "admin-1" },
    });
    expect(mocks.checkUpsert.mock.calls[1]![0]).toMatchObject({
      update: { complianceStatus: "NEEDS_ATTENTION", issuesNote: "Under review", active: false, recordedByUserId: "admin-1" },
    });
    expect(mocks.externalIdentityUpsert).toHaveBeenCalledTimes(2);
    expect(mocks.externalIdentityUpsert.mock.calls[0]![0]).toMatchObject({
      where: { personId_provider_providerScope: { personId: "p-ana", provider: "ROSTER_IMPORT", providerScope: "" } },
      create: { personId: "p-ana", provider: "ROSTER_IMPORT", providerScope: "", externalId: "1" },
      update: { externalId: "1" },
    });
    const audit = mocks.writeAuditLog.mock.calls[0]![0];
    expect(audit).toMatchObject({ action: "BACKGROUND_CHECKS_IMPORTED", metadata: { added: 1, updated: 1, review: 1, skipped: 1 } });
  });
});

describe("club page compliance (#427)", () => {
  it("goes Clear/Needs attention/No record, and only staff get the note", () => {
    expect(clubComplianceState(null, "2026-10-04")).toBe("NO_RECORD");
    expect(clubComplianceState({ complianceStatus: "CLEAR", active: true, expiresOn: null }, "2026-10-04")).toBe("CLEAR");
    expect(clubComplianceState({ complianceStatus: "NEEDS_ATTENTION", active: true, expiresOn: null }, "2026-10-04")).toBe("NEEDS_ATTENTION");
    // An inactive check reads as no record, even if it was once clear.
    expect(clubComplianceState({ complianceStatus: "CLEAR", active: false, expiresOn: null }, "2026-10-04")).toBe("NO_RECORD");
    // No compliance mark: falls back to a Sterling check's expiration date.
    expect(clubComplianceState({ complianceStatus: null, active: true, expiresOn: "2026-10-04" }, "2026-10-04")).toBe("CLEAR");
    expect(clubComplianceState({ complianceStatus: null, active: true, expiresOn: "2026-01-01" }, "2026-10-04")).toBe("NEEDS_ATTENTION");
  });

  it("never includes the note unless the caller is allowed to see it", async () => {
    mocks.rosterFindMany.mockResolvedValue([
      { id: "member-1", person: { backgroundCheck: { complianceStatus: "NEEDS_ATTENTION", active: true, expiresOn: null, issuesNote: "Pending paperwork" } } },
      { id: "member-2", person: { backgroundCheck: null } },
    ]);

    const forClub = await clubRosterComplianceStatuses("org-1", "2026", { includeNotes: false });
    expect(forClub.statuses["member-1"]).toEqual({ state: "NEEDS_ATTENTION", note: null });
    expect(forClub.notInCompliance).toBe(1);
    expect(JSON.stringify(forClub)).not.toContain("Pending paperwork");

    const forStaff = await clubRosterComplianceStatuses("org-1", "2026", { includeNotes: true });
    expect(forStaff.statuses["member-1"]).toEqual({ state: "NEEDS_ATTENTION", note: "Pending paperwork" });
    expect(forStaff.statuses["member-2"]).toEqual({ state: "NO_RECORD", note: null });
  });
});
