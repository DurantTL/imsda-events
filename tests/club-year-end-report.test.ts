import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Pathfinder Year-End Report (#607): year boundaries, each pre-fill rule,
 * totals, locking, overrides, and who may file, reopen, or export. Synthetic
 * data only; the report holds counts, never a name.
 */
const mocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
  orgFindUnique: vi.fn(),
  orgFindMany: vi.fn(),
  reportFindUnique: vi.fn(),
  reportFindMany: vi.fn(),
  reportCreate: vi.fn(),
  reportUpdate: vi.fn(),
  rosterFindMany: vi.fn(),
  completionFindMany: vi.fn(),
  honorFindMany: vi.fn(),
  entryFindMany: vi.fn(),
  getCurrentAttendee: vi.fn(),
  listDirectedClubs: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  currentStaffActingContext: vi.fn(),
  requireSystemAdministrator: vi.fn(),
}));

const client = {
  organization: { findUnique: mocks.orgFindUnique, findMany: mocks.orgFindMany },
  clubYearEndReport: {
    findUnique: mocks.reportFindUnique,
    findMany: mocks.reportFindMany,
    create: mocks.reportCreate,
    update: mocks.reportUpdate,
  },
  clubRosterMember: { findMany: mocks.rosterFindMany },
  memberClassCompletion: { findMany: mocks.completionFindMany },
  honor: { findMany: mocks.honorFindMany },
  memberHonorEntry: { findMany: mocks.entryFindMany },
  $transaction: (work: (tx: unknown) => unknown) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/attendee-accounts/sign-in-gate", () => ({ accountNeedsSecondStep: async () => "OK" }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: mocks.currentStaffActingContext }));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: mocks.listDirectedClubs }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/organizations/access", () => ({ requireSystemAdministrator: mocks.requireSystemAdministrator }));
// Synthetic "sealed" birth dates are stored as the plain date for these tests.
vi.mock("@/modules/club-rosters/birth-dates", () => ({ openBirthDate: (sealed: string) => sealed }));

import { PUT } from "@/app/api/attendee/clubs/[organizationId]/year-end-reports/[year]/route";
import { GET as EXPORT } from "@/app/api/admin/club-reports/year-end/export/route";
import { POST as REOPEN } from "@/app/api/admin/club-reports/year-end/[organizationId]/[year]/reopen/route";
import { AccessDeniedError } from "@/modules/access/authorization";
import { yearEndReportCsv } from "@/modules/club-reports/year-end-csv";
import {
  ageReferenceDate,
  gradeBandForAge,
  isInReportYear,
  isLateYearEndReport,
  isPastDue,
  isReportYear,
  isReportYearOpen,
  isYearEndLockedForClub,
  latestStartedReportYear,
  prefillFromRoster,
  prefillHonors,
  prefillInvestitures,
  reportYearRange,
  reportableReportYears,
  resolveYearEnd,
  resolvedCounts,
  splitYearEndValues,
  yearEndFieldKeys,
  yearEndFields,
  yearEndProgress,
  yearEndTotals,
} from "@/modules/club-reports/year-end-domain";
import {
  getYearEndView,
  listYearEndReportsForYear,
  reopenYearEndReport,
  saveYearEndReport,
  yearEndPrefill,
} from "@/modules/club-reports/year-end-repository";
import { yearEndReportInputSchema } from "@/modules/club-reports/year-end-schemas";

const NOW = new Date("2026-09-29T17:00:00Z");

const allValues = (overrides: Record<string, number> = {}): Record<string, number> => ({
  ...Object.fromEntries(yearEndFieldKeys.map((key) => [key, 0])),
  ...overrides,
});

const input = (overrides: Record<string, unknown> = {}) => yearEndReportInputSchema.parse({
  contactName: "Pat Example",
  contactEmail: "pat@example.test",
  values: allValues(),
  status: "SUBMITTED",
  ...overrides,
});

const stored = (data: Record<string, unknown>) => ({
  id: "report-1",
  organizationId: "club-1",
  reportYear: "2026-27",
  contactName: "",
  contactWorkPhone: "",
  contactHomePhone: "",
  contactCellPhone: "",
  contactEmail: "",
  prefill: {},
  overrides: {},
  manual: {},
  submittedAt: null,
  firstSubmittedAt: null,
  updatedAt: new Date("2026-09-29T17:00:00Z"),
  ...data,
});

const member = (data: Record<string, unknown>) => ({
  attendeeType: "YOUTH", classLevel: null, gender: "MALE", reportedAge: null, sealedBirthDate: null, ...data,
});

/** The roster read for counts and the one for honors share a table; only the honors read selects `person`. */
const rosterRows = (rows: unknown[], honorMembers: unknown[] = []) =>
  mocks.rosterFindMany.mockImplementation((args: { select: Record<string, unknown> }) => Promise.resolve(args.select.person ? honorMembers : rows));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.orgFindUnique.mockResolvedValue({ type: "CLUB", name: "Test Pathfinders" });
  mocks.orgFindMany.mockResolvedValue([]);
  mocks.reportFindUnique.mockResolvedValue(null);
  mocks.reportFindMany.mockResolvedValue([]);
  mocks.reportCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(stored(data)));
  mocks.reportUpdate.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(stored(data)));
  rosterRows([]);
  mocks.completionFindMany.mockResolvedValue([]);
  mocks.honorFindMany.mockResolvedValue([]);
  mocks.entryFindMany.mockResolvedValue([]);
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.currentStaffActingContext.mockResolvedValue(null);
  mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "account-1", verifiedEmail: "r@example.test", displayName: "R" }, via: "attendee", sessionId: "s-1" });
  mocks.requireSystemAdministrator.mockResolvedValue({ id: "staff-1", globalRole: "SYSTEM_ADMIN" });
});

describe("the May 1 to April 30 Pathfinder year", () => {
  it("runs May 1 to April 30, is due April 1, and is labelled by its start year", () => {
    expect(reportYearRange("2026-27")).toEqual({ start: "2026-05-01", end: "2027-04-30", dueDate: "2027-04-01" });
    expect(isReportYear("2026-27")).toBe(true);
    expect(isReportYear("2026-28")).toBe(false);
    expect(isReportYear("2026")).toBe(false);
  });

  it("puts April 30 and May 1 on opposite sides of the boundary", () => {
    expect(isInReportYear("2026-04-30", "2026-27")).toBe(false);
    expect(isInReportYear("2026-05-01", "2026-27")).toBe(true);
    expect(isInReportYear("2027-04-30", "2026-27")).toBe(true);
    expect(isInReportYear("2027-05-01", "2026-27")).toBe(false);
    expect(isInReportYear("2026-04-30", "2025-26")).toBe(true);
  });

  it("starts a new year at May 1 in conference time, and offers only started years", () => {
    // 11 PM Central April 30 is still 2025-26; 1 AM Central May 1 is 2026-27.
    expect(latestStartedReportYear(new Date("2026-05-01T04:00:00Z"))).toBe("2025-26");
    expect(latestStartedReportYear(new Date("2026-05-01T06:00:00Z"))).toBe("2026-27");
    expect(latestStartedReportYear(NOW)).toBe("2026-27");
    expect(reportableReportYears(NOW)).toEqual(["2026-27", "2025-26"]);
    expect(isReportYearOpen("2026-27", NOW)).toBe(true);
    expect(isReportYearOpen("2027-28", NOW)).toBe(false);
  });

  it("works out ages on the year's last day, or today while the year is running", () => {
    expect(ageReferenceDate("2026-27", NOW)).toBe("2026-09-29");
    expect(ageReferenceDate("2026-27", new Date("2027-08-01T12:00:00Z"))).toBe("2027-04-30");
  });

  it("is late only after April 1 in conference time", () => {
    expect(isPastDue("2026-27", new Date("2027-04-02T04:00:00Z"))).toBe(false);
    expect(isPastDue("2026-27", new Date("2027-04-02T06:00:00Z"))).toBe(true);
    expect(isLateYearEndReport("2026-27", new Date("2027-04-02T04:00:00Z"))).toBe(false);
    expect(isLateYearEndReport("2026-27", new Date("2027-04-05T15:00:00Z"))).toBe(true);
  });
});

describe("roster pre-fill (sections 1 to 4)", () => {
  it("maps age to the paper form's bands", () => {
    expect([9, 10, 12].map(gradeBandForAge)).toEqual(["57", "57", "57"]);
    expect([13, 15].map(gradeBandForAge)).toEqual(["810", "810"]);
    expect([16, 18, 19].map(gradeBandForAge)).toEqual(["1112", "1112", "1112"]);
  });

  it("counts youth by gender and age band, TLTs included, and staff apart from TLTs", () => {
    const result = prefillFromRoster([
      { attendeeType: "YOUTH", classLevel: "FRIEND", gender: "MALE", age: 10 },
      { attendeeType: "YOUTH", classLevel: "RANGER", gender: "FEMALE", age: 14 },
      { attendeeType: "YOUTH", classLevel: "TLT", gender: "FEMALE", age: 17 },
      { attendeeType: "YOUTH", classLevel: "TLT", gender: "MALE", age: 16 },
      { attendeeType: "STAFF", classLevel: null, gender: "MALE", age: 40 },
      { attendeeType: "STAFF", classLevel: null, gender: "FEMALE", age: 41 },
      { attendeeType: "STAFF", classLevel: "MASTER_GUIDE", gender: "FEMALE", age: 50 },
      { attendeeType: "ADULT", classLevel: null, gender: "MALE", age: 45 },
      { attendeeType: "UNDERAGE", classLevel: null, gender: "MALE", age: 6 },
    ]);
    expect(result.counts).toMatchObject({
      memberMale57: 1, memberFemale810: 1, memberFemale1112: 1, memberMale1112: 1, memberMale810: 0, memberFemale57: 0,
      staffMale: 1, staffFemale: 2,
    });
    expect(result.tltsOnRoster).toBe(2);
    expect(yearEndTotals(result.counts)).toMatchObject({ membership: 4, staff: 3, totalMembership: 7 });
  });

  it("leaves out members it can't place, and says how many, without naming anyone", () => {
    const result = prefillFromRoster([
      { attendeeType: "YOUTH", classLevel: null, gender: null, age: 11 },
      { attendeeType: "YOUTH", classLevel: null, gender: "MALE", age: null },
      { attendeeType: "STAFF", classLevel: null, gender: null, age: 33 },
    ]);
    expect(result.unplaced).toEqual({ membersWithoutGender: 1, membersWithoutAge: 1, staffWithoutGender: 1 });
    expect(yearEndTotals(result.counts).totalMembership).toBe(0);
  });

  it("estimates age from the sealed birth date on the reference date, falling back to the reported age", async () => {
    rosterRows([
      // Birthday 2014-10-01: 11 on 2026-09-29 (grades 5-7); one day later would be 12, still the same band.
      member({ gender: "FEMALE", sealedBirthDate: "2014-10-01" }),
      // Turns 13 the day after the reference date, so still 12.
      member({ gender: "MALE", sealedBirthDate: "2013-09-30" }),
      // No birth date: the reported age of 14 is used.
      member({ gender: "MALE", reportedAge: 14 }),
      member({ attendeeType: "STAFF", gender: "FEMALE" }),
    ]);
    const { values } = await yearEndPrefill("club-1", "2026-27", NOW);
    expect(values).toMatchObject({ memberFemale57: 1, memberMale57: 1, memberMale810: 1, staffFemale: 1 });
    expect(mocks.rosterFindMany.mock.calls[0][0].where).toMatchObject({ organizationId: "club-1", clubYear: "2026-27", status: "ACTIVE" });
  });
});

describe("investiture pre-fill (section 7)", () => {
  it("counts class completions dated inside the year, by class, and leaves advanced levels manual", () => {
    const counts = prefillInvestitures([
      { classLevel: "FRIEND", completedOn: "2026-05-01" },
      { classLevel: "FRIEND", completedOn: "2027-04-30" },
      { classLevel: "FRIEND", completedOn: "2026-04-30" },
      { classLevel: "FRIEND", completedOn: "2027-05-01" },
      { classLevel: "GUIDE", completedOn: "2026-10-10" },
      { classLevel: "MASTER_GUIDE", completedOn: "2026-11-01" },
      { classLevel: "TLT", completedOn: "2026-11-01" },
    ], "2026-27");
    expect(counts).toMatchObject({ investedFRIEND: 2, investedGUIDE: 1, investedMASTER_GUIDE: 1, investedCOMPANION: 0 });
    expect(Object.keys(counts)).not.toContain("investedTLT");
    const advanced = yearEndFields.filter((field) => field.key.startsWith("investedAdvanced"));
    expect(advanced).toHaveLength(6);
    expect(advanced.every((field) => field.source === "manual")).toBe(true);
  });

  it("asks the database only for this club's completions inside the year", async () => {
    await yearEndPrefill("club-1", "2026-27", NOW);
    expect(mocks.completionFindMany.mock.calls[0][0].where).toEqual({
      organizationId: "club-1", completedOn: { gte: "2026-05-01", lte: "2027-04-30" },
    });
  });
});

describe("honor pre-fill (sections 8 and 9)", () => {
  it("counts completed honors dated in the year, Masters apart, in-progress and out-of-year ignored", () => {
    expect(prefillHonors([
      { status: "COMPLETED", completionDate: "2026-06-01", isMaster: false },
      { status: "COMPLETED", completionDate: "2027-04-30", isMaster: false },
      { status: "COMPLETED", completionDate: "2026-04-30", isMaster: false },
      { status: "IN_PROGRESS", completionDate: "", isMaster: false },
      { status: "COMPLETED", completionDate: "2026-12-01", isMaster: true },
    ], "2026-27")).toEqual({ honors: 2, honorMasters: 1 });
  });

  it("leaves out voided entries, so a voided completion isn't counted and an earlier one shows through", async () => {
    mocks.rosterFindMany.mockImplementation((args: { select: Record<string, unknown> }) => Promise.resolve(
      args.select.person
        ? [{ id: "m1", classLevel: null, person: { id: "p1", firstName: "A", lastName: "B" } }, { id: "m2", classLevel: null, person: { id: "p2", firstName: "C", lastName: "D" } }]
        : [],
    ));
    const entry = (data: Record<string, unknown>) => ({
      note: "", createdAt: new Date("2026-08-01T00:00:00Z"), organizationId: "club-1",
      honor: { code: "H", name: "An honor" }, recordedByAccount: null, recordedByUser: null, organization: { name: "Test Pathfinders" }, void: null,
      ...data,
    });
    const voided = { reason: "Recorded by mistake", createdAt: new Date("2026-09-01T00:00:00Z"), voidedByAccount: null, voidedByUser: null };
    // Newest first, as the repository orders them.
    mocks.entryFindMany.mockResolvedValue([
      // p1: the newest COMPLETED entry is voided, so nothing in the year counts for this honor.
      entry({ id: "e3", personId: "p1", honorId: "h1", status: "COMPLETED", completionDate: "2026-09-01", void: voided }),
      entry({ id: "e2", personId: "p1", honorId: "h1", status: "IN_PROGRESS", completionDate: "" }),
      // p2: a valid completion, and a Master Award completion.
      entry({ id: "e5", personId: "p2", honorId: "h2", status: "COMPLETED", completionDate: "2026-10-01" }),
      entry({ id: "e4", personId: "p2", honorId: "h3", status: "COMPLETED", completionDate: "2026-10-05" }),
    ]);
    mocks.honorFindMany.mockResolvedValue([
      { id: "h1", category: "NATURE" }, { id: "h2", category: "NATURE" }, { id: "h3", category: "MASTER_AWARDS" },
    ]);
    const { values } = await yearEndPrefill("club-1", "2026-27", NOW);
    expect(values).toMatchObject({ honors: 1, honorMasters: 1 });
  });

  it("falls back to the earlier completion when the latest one is voided", async () => {
    mocks.rosterFindMany.mockImplementation((args: { select: Record<string, unknown> }) => Promise.resolve(
      args.select.person ? [{ id: "m1", classLevel: null, person: { id: "p1", firstName: "A", lastName: "B" } }] : [],
    ));
    const base = { note: "", createdAt: new Date("2026-08-01T00:00:00Z"), organizationId: "club-1", honor: { code: "H", name: "An honor" }, recordedByAccount: null, recordedByUser: null, organization: { name: "T" }, personId: "p1", honorId: "h1", status: "COMPLETED" };
    mocks.entryFindMany.mockResolvedValue([
      { ...base, id: "e2", completionDate: "2026-11-01", void: { reason: "Wrong date entered", createdAt: new Date(), voidedByAccount: null, voidedByUser: null } },
      { ...base, id: "e1", completionDate: "2026-07-01", void: null },
    ]);
    mocks.honorFindMany.mockResolvedValue([{ id: "h1", category: "NATURE" }]);
    expect((await yearEndPrefill("club-1", "2026-27", NOW)).values.honors).toBe(1);
  });
});

describe("totals and overrides", () => {
  it("adds up every section on the form, from the counts, never from typed totals", () => {
    const totals = yearEndTotals(allValues({
      memberMale57: 4, memberFemale57: 3, memberMale810: 2, memberFemale810: 5, memberMale1112: 1, memberFemale1112: 1,
      staffMale: 2, staffFemale: 3,
      tltMale12: 1, tltFemale12: 2, tltMale34: 3, tltFemale34: 4,
      baptismJunior: 1, baptismEarliteen: 2, baptismTeen: 3, baptismAdult: 9,
      investedFRIEND: 2, investedAdvancedFRIEND: 1, investedMASTER_GUIDE: 1,
    }));
    expect(totals).toEqual({ membership: 16, staff: 5, totalMembership: 21, tlts: 10, youthBaptisms: 6, invested: 4 });
  });

  it("rejects a total sent by the browser", () => {
    expect(() => yearEndReportInputSchema.parse({ values: allValues({}), status: "DRAFT", totalMembership: 99 })).toThrow();
    expect(() => yearEndReportInputSchema.parse({ values: { ...allValues(), totalMembership: 5 }, status: "DRAFT" })).toThrow();
  });

  it("stores an override only where it differs, and keeps the pre-filled number beside it", () => {
    const prefill = { memberMale57: 4, honors: 10, investedFRIEND: 2 };
    const { overrides, manual } = splitYearEndValues({ memberMale57: 4, honors: 12, investedFRIEND: null, baptismAdult: 3 }, prefill);
    expect(overrides).toEqual({ honors: 12 });
    expect(manual).toEqual({ baptismAdult: 3 });
    const resolved = resolveYearEnd({ prefill, overrides, manual });
    expect(resolved.honors).toEqual({ value: 12, prefill: 10, overridden: true });
    expect(resolved.memberMale57).toEqual({ value: 4, prefill: 4, overridden: false });
    expect(resolved.baptismAdult).toEqual({ value: 3, prefill: null, overridden: false });
    expect(resolvedCounts(resolved).honors).toBe(12);
  });

  it("counts submitted and missing clubs; a draft is still missing", () => {
    expect(yearEndProgress([{ status: "SUBMITTED" }, { status: "DRAFT" }, { status: "NONE" }])).toEqual({ submitted: 1, missing: 2, drafts: 1 });
  });
});

describe("saving, locking and reopening", () => {
  it("saves a draft with the pre-filled snapshot and no first-submission time", async () => {
    rosterRows([member({ reportedAge: 11 })]);
    const report = await saveYearEndReport("club-1", "2026-27", input({ status: "DRAFT", contactName: "", contactEmail: "" }), { accountId: "account-1" }, NOW);
    expect(report.status).toBe("DRAFT");
    const data = mocks.reportCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: "DRAFT", submittedAt: null, firstSubmittedAt: null, updatedByAccountId: "account-1" });
    expect(data).not.toHaveProperty("submittedByAccountId");
    expect(data.prefill).toMatchObject({ memberMale57: 1 });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CLUB_YEAR_END_REPORT_DRAFT_SAVED" }), client);
  });

  it("keeps the override and the pre-filled number, and calculates totals from the override", async () => {
    rosterRows([member({ reportedAge: 11 }), member({ reportedAge: 11 })]);
    const report = await saveYearEndReport("club-1", "2026-27", input({ values: allValues({ memberMale57: 5, baptismAdult: 2 }) }), { accountId: "account-1" }, NOW);
    const data = mocks.reportCreate.mock.calls[0][0].data;
    expect(data.prefill.memberMale57).toBe(2);
    expect(data.overrides).toEqual({ memberMale57: 5 });
    expect(data.manual).toMatchObject({ baptismAdult: 2 });
    expect(data).not.toHaveProperty("totals");
    expect(report.resolved.memberMale57).toEqual({ value: 5, prefill: 2, overridden: true });
    expect(report.totals.membership).toBe(5);
  });

  it("submits, records the first submission time, and flags a submission after April 1 as late", async () => {
    const ontime = await saveYearEndReport("club-1", "2026-27", input(), { accountId: "account-1" }, new Date("2027-03-30T15:00:00Z"));
    expect(ontime.late).toBe(false);
    expect(mocks.reportCreate.mock.calls[0][0].data).toMatchObject({ status: "SUBMITTED", submittedByAccountId: "account-1" });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CLUB_YEAR_END_REPORT_SUBMITTED" }), client);
    const late = await saveYearEndReport("club-1", "2026-27", input(), { accountId: "account-1" }, new Date("2027-04-10T15:00:00Z"));
    expect(late.late).toBe(true);
  });

  it("needs a name and an email to submit, but not for a draft", () => {
    expect(() => input({ contactName: "" })).toThrow(/name/i);
    expect(() => input({ contactEmail: "" })).toThrow(/email/i);
    expect(() => input({ contactEmail: "not-an-email" })).toThrow(/valid email/i);
    expect(() => input({ status: "DRAFT", contactName: "", contactEmail: "" })).not.toThrow();
  });

  it("refuses a year that hasn't started", async () => {
    await expect(saveYearEndReport("club-1", "2027-28", input(), { accountId: "account-1" }, NOW))
      .rejects.toMatchObject({ code: "CLUB_REPORT_YEAR_INVALID" });
    expect(mocks.reportCreate).not.toHaveBeenCalled();
  });

  it("locks a submitted report for the club, including a staff act-as director, and lets a draft still be filed late", async () => {
    expect(isYearEndLockedForClub("SUBMITTED")).toBe(true);
    expect(isYearEndLockedForClub("DRAFT")).toBe(false);
    mocks.reportFindUnique.mockResolvedValue({ id: "report-1", status: "SUBMITTED", firstSubmittedAt: new Date("2027-03-01T15:00:00Z"), submittedAt: new Date("2027-03-01T15:00:00Z") });
    await expect(saveYearEndReport("club-1", "2026-27", input(), { accountId: "account-1" }, new Date("2027-03-05T15:00:00Z")))
      .rejects.toMatchObject({ code: "CLUB_REPORT_LOCKED" });
    await expect(saveYearEndReport("club-1", "2026-27", input(), { userId: "staff-1", actAsId: "act-1" }, new Date("2027-03-05T15:00:00Z")))
      .rejects.toMatchObject({ code: "CLUB_REPORT_LOCKED" });
    expect(mocks.reportUpdate).not.toHaveBeenCalled();
    // A draft after the due date is still fileable, and shows as late.
    mocks.reportFindUnique.mockResolvedValue({ id: "report-1", status: "DRAFT", firstSubmittedAt: null, submittedAt: null });
    const filed = await saveYearEndReport("club-1", "2026-27", input(), { accountId: "account-1" }, new Date("2027-04-20T15:00:00Z"));
    expect(filed.status).toBe("SUBMITTED");
    expect(filed.late).toBe(true);
  });

  it("lets staff reopen a submitted report, after which the club can edit it again", async () => {
    mocks.reportFindUnique.mockResolvedValue({ id: "report-1", status: "SUBMITTED" });
    const reopened = await reopenYearEndReport("club-1", "2026-27", "staff-1");
    expect(reopened.status).toBe("DRAFT");
    expect(mocks.reportUpdate.mock.calls[0][0].data).toMatchObject({ status: "DRAFT", submittedAt: null, updatedByUserId: "staff-1" });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CLUB_YEAR_END_REPORT_REOPENED", actorUserId: "staff-1" }), client);
    mocks.reportFindUnique.mockResolvedValue({ id: "report-1", status: "DRAFT", firstSubmittedAt: new Date("2027-03-01T15:00:00Z"), submittedAt: null });
    await expect(saveYearEndReport("club-1", "2026-27", input(), { accountId: "account-1" }, new Date("2027-03-05T15:00:00Z"))).resolves.toBeTruthy();
    mocks.reportFindUnique.mockResolvedValue({ id: "report-1", status: "DRAFT" });
    await expect(reopenYearEndReport("club-1", "2026-27", "staff-1")).rejects.toMatchObject({ code: "CLUB_REPORT_NOT_SUBMITTED" });
    mocks.reportFindUnique.mockResolvedValue(null);
    await expect(reopenYearEndReport("club-1", "2026-27", "staff-1")).rejects.toMatchObject({ code: "CLUB_REPORT_NOT_FOUND" });
  });

  it("shows a submitted report's frozen snapshot, not the roster as it is now", async () => {
    mocks.reportFindUnique.mockResolvedValue(stored({
      status: "SUBMITTED", prefill: { memberMale57: 7 }, overrides: {}, manual: {}, firstSubmittedAt: new Date("2027-03-01T15:00:00Z"),
    }));
    rosterRows([member({ reportedAge: 11 })]);
    const view = await getYearEndView("club-1", "2026-27", NOW);
    expect(view.resolved.memberMale57.value).toBe(7);
    expect(mocks.rosterFindMany).not.toHaveBeenCalled();
  });

  it("shows a draft with fresh pre-fill beside the director's earlier override", async () => {
    mocks.reportFindUnique.mockResolvedValue(stored({ status: "DRAFT", prefill: { memberMale57: 1 }, overrides: { memberMale57: 9 }, manual: { baptismAdult: 2 } }));
    rosterRows([member({ reportedAge: 11 }), member({ reportedAge: 12 })]);
    const view = await getYearEndView("club-1", "2026-27", NOW);
    expect(view.resolved.memberMale57).toEqual({ value: 9, prefill: 2, overridden: true });
    expect(view.resolved.baptismAdult.value).toBe(2);
  });
});

describe("who may file, reopen, or export", () => {
  const request = (body: unknown = { contactName: "Pat Example", contactEmail: "pat@example.test", values: allValues(), status: "SUBMITTED" }) =>
    new Request("https://events.imsda.test/api/attendee/clubs/club-1/year-end-reports/2026-27", {
      method: "PUT",
      headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const ctx = { params: Promise.resolve({ organizationId: "club-1", year: "2026-27" }) };
  const directed = (organizationId: string, role: string) =>
    mocks.listDirectedClubs.mockResolvedValue([{ organizationId, name: "Test Pathfinders", role, sponsoringChurch: null }]);

  it("lets a director, a deputy, and a reporter file", async () => {
    for (const role of ["DIRECTOR", "DEPUTY", "REPORTER"]) {
      directed("club-1", role);
      expect((await PUT(request(), ctx)).status, role).toBe(200);
    }
  });

  it("keeps a registrar out, and touches nothing", async () => {
    directed("club-1", "REGISTRAR");
    expect((await PUT(request(), ctx)).status).toBe(403);
    expect(mocks.reportCreate).not.toHaveBeenCalled();
  });

  it("hides the club from anyone else, including another club's director", async () => {
    mocks.listDirectedClubs.mockResolvedValue([]);
    expect((await PUT(request(), ctx)).status).toBe(404);
    directed("club-2", "DIRECTOR");
    expect((await PUT(request(), ctx)).status).toBe(404);
    expect(mocks.reportCreate).not.toHaveBeenCalled();
  });

  it("requires sign-in", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account: null, via: null, sessionId: null });
    expect((await PUT(request(), ctx)).status).toBe(401);
  });

  it("answers 409 for a locked report and 400 for a bad year or body", async () => {
    directed("club-1", "DIRECTOR");
    mocks.reportFindUnique.mockResolvedValue({ id: "report-1", status: "SUBMITTED", firstSubmittedAt: new Date(), submittedAt: new Date() });
    expect((await PUT(request(), ctx)).status).toBe(409);
    expect((await PUT(request(), { params: Promise.resolve({ organizationId: "club-1", year: "nope" }) })).status).toBe(400);
    expect((await PUT(request({ values: allValues(), status: "SUBMITTED", totalMembership: 4 }), ctx)).status).toBe(400);
  });

  it("lets staff reopen; a non-staff account gets a 403 and nothing changes", async () => {
    const post = () => new Request("https://events.imsda.test/api/admin/club-reports/year-end/club-1/2026-27/reopen", {
      method: "POST", headers: { origin: "https://events.imsda.test" },
    });
    mocks.reportFindUnique.mockResolvedValue({ id: "report-1", status: "SUBMITTED" });
    expect((await REOPEN(post(), ctx)).status).toBe(200);
    mocks.reportUpdate.mockClear();
    mocks.requireSystemAdministrator.mockRejectedValue(new AccessDeniedError("System administrator access is required.", 403, "PERMISSION_DENIED"));
    expect((await REOPEN(post(), ctx)).status).toBe(403);
    expect(mocks.reportUpdate).not.toHaveBeenCalled();
  });

  it("lets staff export the CSV and refuses everyone else", async () => {
    mocks.orgFindMany.mockResolvedValue([
      { id: "club-1", name: "Test Pathfinders", parentOrganization: { name: "Test Church" } },
      { id: "club-2", name: "Sample Pathfinders", parentOrganization: null },
    ]);
    mocks.reportFindMany.mockResolvedValue([stored({
      status: "SUBMITTED", contactName: "Pat Example", contactEmail: "pat@example.test",
      prefill: { memberMale57: 3 }, overrides: {}, manual: { baptismAdult: 1 },
      submittedAt: new Date("2027-03-10T15:00:00Z"), firstSubmittedAt: new Date("2027-03-10T15:00:00Z"),
    })]);
    const response = await EXPORT(new Request("https://events.imsda.test/api/admin/club-reports/year-end/export?year=2026-27"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("year-end-reports-2026-27.csv");
    const lines = (await response.text()).trim().split("\r\n");
    expect(lines).toHaveLength(3);
    mocks.requireSystemAdministrator.mockRejectedValue(new AccessDeniedError("System administrator access is required.", 403, "PERMISSION_DENIED"));
    expect((await EXPORT(new Request("https://events.imsda.test/api/admin/club-reports/year-end/export"))).status).toBe(403);
  });
});

describe("staff list and CSV", () => {
  it("lists every club with its status, and only a submitted report's numbers", async () => {
    mocks.orgFindMany.mockResolvedValue([
      { id: "club-1", name: "Alpha", parentOrganization: { name: "Test Church" } },
      { id: "club-2", name: "Bravo", parentOrganization: null },
      { id: "club-3", name: "Charlie", parentOrganization: null },
    ]);
    mocks.reportFindMany.mockResolvedValue([
      stored({ organizationId: "club-1", status: "SUBMITTED", prefill: { memberMale57: 2 }, firstSubmittedAt: new Date("2027-04-09T15:00:00Z"), submittedAt: new Date("2027-04-09T15:00:00Z") }),
      stored({ id: "report-2", organizationId: "club-2", status: "DRAFT", prefill: { memberMale57: 9 } }),
    ]);
    const clubs = await listYearEndReportsForYear("2026-27");
    expect(clubs.map((club) => [club.name, club.status, club.late])).toEqual([["Alpha", "SUBMITTED", true], ["Bravo", "DRAFT", false], ["Charlie", "NONE", false]]);
    expect(clubs[1].report).toBeNull();
    expect(yearEndProgress(clubs)).toEqual({ submitted: 1, missing: 2, drafts: 1 });
  });

  it("has one row per club, the paper form's columns in order with totals, and no names of young people", async () => {
    mocks.orgFindMany.mockResolvedValue([
      { id: "club-1", name: "Alpha", parentOrganization: { name: "Test Church" } },
      { id: "club-2", name: "Bravo", parentOrganization: null },
    ]);
    mocks.reportFindMany.mockResolvedValue([stored({
      organizationId: "club-1", status: "SUBMITTED", contactName: "Pat Example", contactWorkPhone: "555-0100", contactEmail: "pat@example.test",
      prefill: { memberMale57: 3, memberFemale57: 2, staffMale: 1, honors: 4 },
      overrides: { honors: 6 },
      manual: { tltMale12: 1, baptismJunior: 2, baptismAdult: 1, investedAdvancedFRIEND: 1 },
      firstSubmittedAt: new Date("2027-03-10T15:00:00Z"), submittedAt: new Date("2027-03-10T15:00:00Z"),
    })]);
    const csv = yearEndReportCsv(await listYearEndReportsForYear("2026-27"));
    const [header, alpha, bravo] = csv.trim().split("\r\n").map((line) => line.slice(1, -1).split('","'));
    expect(header.slice(0, 10)).toEqual(["Club", "Sponsoring church", "Status", "Submitted on", "Late", "Name", "Work phone", "Home phone", "Cell phone", "Email"]);
    const column = (name: string) => header.indexOf(name);
    expect(header).toEqual(expect.arrayContaining([
      "Membership total", "Staff total", "Total membership", "TLTs total", "Youth baptisms total", "Adult baptisms",
      "Invested: Friend", "Invested: Trail Friend", "Invested: Master Guide", "Invested total",
      "Honors awarded (not counting Masters)", "Honor Masters awarded",
      "Staff completing the Pathfinder Leadership Award", "Staff completing the Pathfinder Instructor Award",
    ]));
    // Paper order: membership, then staff, then TLTs, then baptisms, invested, honors, awards.
    expect(column("Membership total")).toBeLessThan(column("Staff Male"));
    expect(column("Total membership")).toBeLessThan(column("TLTs Male, Levels 1 & 2"));
    expect(column("Youth baptisms total")).toBeLessThan(column("Adult baptisms"));
    expect(column("Invested total")).toBeLessThan(column("Honors awarded (not counting Masters)"));
    expect(alpha[column("Club")]).toBe("Alpha");
    expect(alpha[column("Status")]).toBe("Submitted");
    expect(alpha[column("Submitted on")]).toBe("2027-03-10");
    expect(alpha[column("Late")]).toBe("No");
    expect(alpha[column("Membership total")]).toBe("5");
    expect(alpha[column("Total membership")]).toBe("6");
    expect(alpha[column("Youth baptisms total")]).toBe("2");
    expect(alpha[column("Invested total")]).toBe("1");
    // The override wins in the export.
    expect(alpha[column("Honors awarded (not counting Masters)")]).toBe("6");
    expect(bravo[column("Club")]).toBe("Bravo");
    expect(bravo[column("Status")]).toBe("Not started");
    expect(bravo[column("Membership total")]).toBe("");
    expect(header.join(" ")).not.toMatch(/first name|last name|birth/i);
  });
});
