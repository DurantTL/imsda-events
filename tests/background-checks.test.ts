import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  personFindMany: vi.fn(),
  checkFindMany: vi.fn(),
  checkUpsert: vi.fn(),
  eventFindUnique: vi.fn(),
  attendeeFindMany: vi.fn(),
  rosterFindMany: vi.fn(),
  writeAuditLog: vi.fn(),
}));

const client = {
  person: { findMany: mocks.personFindMany },
  backgroundCheck: { findMany: mocks.checkFindMany, upsert: mocks.checkUpsert },
  event: { findUnique: mocks.eventFindUnique },
  registrationAttendee: { findMany: mocks.attendeeFindMany },
  clubRosterMember: { findMany: mocks.rosterFindMany },
  $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/club-rosters/birth-dates", () => ({ openBirthDate: (sealed: string) => sealed.replace("sealed:", "") }));

import {
  attendeeIsAdult,
  backgroundCheckState,
  isClearStatus,
  normalizeCheckDate,
  parseSterlingCsv,
  SterlingCsvError,
} from "@/modules/background-checks/domain";
import { applySterlingImport, listEventBackgroundFlags, planSterlingImport } from "@/modules/background-checks/repository";

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
