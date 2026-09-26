import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
  orgFindUnique: vi.fn(),
  reportFindUnique: vi.fn(),
  reportCreate: vi.fn(),
  reportUpdate: vi.fn(),
  getCurrentAttendee: vi.fn(),
  listDirectedClubs: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  currentStaffActingContext: vi.fn(),
}));

const mocksExtra = vi.hoisted(() => ({
  orgFindMany: vi.fn(),
  reportFindMany: vi.fn(),
  standingFindMany: vi.fn(),
}));

const client = {
  organization: { findUnique: mocks.orgFindUnique, findMany: mocksExtra.orgFindMany },
  clubMonthlyReport: {
    findUnique: mocks.reportFindUnique,
    create: mocks.reportCreate,
    update: mocks.reportUpdate,
    findMany: mocksExtra.reportFindMany,
  },
  clubYearStanding: { findMany: mocksExtra.standingFindMany },
  $transaction: (work: (tx: unknown) => unknown) => work(client),
};

const secondStep = vi.hoisted(() => ({ accountNeedsSecondStep: vi.fn(async () => "OK") }));
vi.mock("server-only", () => ({}));
vi.mock("@/modules/attendee-accounts/sign-in-gate", () => ({ accountNeedsSecondStep: secondStep.accountNeedsSecondStep }));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: mocks.currentStaffActingContext }));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: mocks.listDirectedClubs }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));

import { PUT } from "@/app/api/attendee/clubs/[organizationId]/reports/[month]/route";
import { clubYearReportCsv } from "@/modules/club-reports/csv";
import {
  MAX_MONTHLY_POINTS,
  clubYearMonths,
  isLockedForClub,
  isOnTime,
  pickedTotal,
  reportDueDate,
  reportProblems,
  reportableMonths,
  yearToDate,
} from "@/modules/club-reports/domain";
import { listClubReportsForYear, reopenClubReport, saveClubReport } from "@/modules/club-reports/repository";
import { clubReportInputSchema } from "@/modules/club-reports/schemas";

const input = (overrides: Record<string, unknown> = {}) => clubReportInputSchema.parse({
  points: { staffMeeting: 25, meetingsOutings: 75, honors: 50, classLevel: 25 },
  honors: [{ name: "Knot Tying", participants: 8 }, { name: "Camping Skills I", participants: 6 }],
  classLevels: ["FRIEND", "COMPANION"],
  signatureName: "Pat Example",
  signedOn: "2026-11-05",
  status: "SUBMITTED",
  ...overrides,
});

const stored = (data: Record<string, unknown>) => ({
  id: "report-1",
  organizationId: "club-1",
  reportMonth: "2026-10",
  honors: [],
  points: {},
  classLevels: [],
  firstSubmittedAt: new Date("2026-11-05T15:00:00Z"),
  updatedAt: new Date("2026-11-05T15:00:00Z"),
  ...data,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.orgFindUnique.mockResolvedValue({ type: "CLUB", name: "Test Pathfinders" });
  mocks.reportFindUnique.mockResolvedValue(null);
  mocks.reportCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(stored(data)));
  mocks.reportUpdate.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(stored(data)));
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.currentStaffActingContext.mockResolvedValue(null);
  mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "account-1", verifiedEmail: "r@example.test", displayName: "R" }, via: "attendee", sessionId: "s-1" });
  mocksExtra.orgFindMany.mockResolvedValue([]);
  mocksExtra.reportFindMany.mockResolvedValue([]);
  mocksExtra.standingFindMany.mockResolvedValue([]);
});

describe("monthly report rules (#377)", () => {
  it("is due the 10th of the next month, in conference time", () => {
    expect(reportDueDate("2026-10")).toBe("2026-11-10");
    expect(reportDueDate("2026-12")).toBe("2027-01-10");
    // 11:30 PM Central on the 10th is still on time; just after midnight is not.
    expect(isOnTime("2026-10", new Date("2026-11-11T05:30:00Z"))).toBe(true);
    expect(isOnTime("2026-10", new Date("2026-11-11T06:30:00Z"))).toBe(false);
    expect(isLockedForClub("2026-10", new Date("2026-11-10T20:00:00Z"))).toBe(false);
    expect(isLockedForClub("2026-10", new Date("2026-11-11T07:00:00Z"))).toBe(true);
  });

  it("refuses values an item doesn't allow, and points the list doesn't back up", () => {
    expect(reportProblems({ points: { uniformMeetings: 15 }, honors: [], classLevels: [] })[0].message).toMatch(/15 isn't allowed/);
    expect(reportProblems({ points: { honors: 75 }, honors: [{ name: "Knots", participants: 3 }], classLevels: [] })[0])
      .toMatchObject({ key: "honors" });
    expect(reportProblems({ points: { classLevel: 25 }, honors: [], classLevels: [] })[0]).toMatchObject({ key: "classLevel" });
    expect(reportProblems({ points: { honors: 25, classLevel: 25 }, honors: [{ name: "Knots", participants: 3 }], classLevels: ["FRIEND"] })).toEqual([]);
  });

  it("adds up the picked items; a perfect month is 625", () => {
    expect(pickedTotal({ staffMeeting: 25, bonus: 50 })).toBe(75);
    expect(MAX_MONTHLY_POINTS).toBe(625);
    expect(yearToDate([{ totalPoints: 300 }, { totalPoints: 200 }], true)).toBe(2000);
  });

  it("runs the club year September to August and never offers future months", () => {
    expect(clubYearMonths("2026-27")[0]).toBe("2026-09");
    expect(clubYearMonths("2026-27")[11]).toBe("2027-08");
    expect(reportableMonths("2026-27", new Date("2026-11-15T18:00:00Z"))).toEqual(["2026-09", "2026-10", "2026-11"]);
  });
});

describe("saving a report", () => {
  it("works out the total and on-time points itself", async () => {
    const report = await saveClubReport("club-1", "2026-10", input(), { accountId: "account-1" }, new Date("2026-11-05T15:00:00Z"));
    expect(report.totalPoints).toBe(25 + 25 + 75 + 50 + 25);
    expect(mocks.reportCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ onTimePoints: 25, clubYear: "2026-27", submittedByAccountId: "account-1" }),
    }));
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CLUB_REPORT_SUBMITTED" }), client);
  });

  it("gives no on-time points to a late first submission, and keeps them on later edits", async () => {
    await saveClubReport("club-1", "2026-09", input(), { accountId: "account-1" }, new Date("2026-11-05T15:00:00Z"));
    expect(mocks.reportCreate.mock.calls[0][0].data.onTimePoints).toBe(0);

    mocks.reportFindUnique.mockResolvedValue({ id: "report-1", firstSubmittedAt: new Date("2026-11-02T15:00:00Z") });
    await saveClubReport("club-1", "2026-10", input(), { accountId: "account-1" }, new Date("2026-11-09T15:00:00Z"));
    expect(mocks.reportUpdate.mock.calls[0][0].data.onTimePoints).toBe(25);
  });

  it("locks the club out after the due date but not conference staff", async () => {
    mocks.reportFindUnique.mockResolvedValue({ id: "report-1", status: "SUBMITTED", firstSubmittedAt: new Date("2026-11-02T15:00:00Z") });
    const after = new Date("2026-11-12T15:00:00Z");
    await expect(saveClubReport("club-1", "2026-10", input(), { accountId: "account-1" }, after)).rejects.toMatchObject({ code: "CLUB_REPORT_LOCKED" });
    await expect(saveClubReport("club-1", "2026-10", input(), { userId: "staff-1" }, after)).resolves.toBeTruthy();
    expect(mocks.reportUpdate.mock.calls[0][0].data).toMatchObject({ updatedByUserId: "staff-1", onTimePoints: 25 });
  });

  it("refuses future months and over-limit values", async () => {
    await expect(saveClubReport("club-1", "2026-12", input(), { accountId: "account-1" }, new Date("2026-11-05T15:00:00Z")))
      .rejects.toMatchObject({ code: "CLUB_REPORT_MONTH_INVALID" });
    await expect(saveClubReport("club-1", "2026-10", input({ points: { devotions: 60 } }), { accountId: "account-1" }, new Date("2026-11-05T15:00:00Z")))
      .rejects.toMatchObject({ code: "CLUB_REPORT_INVALID_POINTS" });
    expect(mocks.reportCreate).not.toHaveBeenCalled();
  });
});

describe("who may file", () => {
  const request = () => new Request("https://events.imsda.test/api/attendee/clubs/club-1/reports/2026-09", {
    method: "PUT",
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: JSON.stringify({ points: { staffMeeting: 25 }, signatureName: "Pat Example", signedOn: "2026-10-05", status: "SUBMITTED" }),
  });
  const ctx = { params: Promise.resolve({ organizationId: "club-1", month: "2026-09" }) };

  it("lets a reporter submit without the roster's second step", async () => {
    mocks.listDirectedClubs.mockResolvedValue([{ organizationId: "club-1", name: "Test Pathfinders", role: "REPORTER", sponsoringChurch: null }]);
    const response = await PUT(request(), ctx);
    expect(response.status).toBe(200);
  });

  it("keeps a registrar out", async () => {
    mocks.listDirectedClubs.mockResolvedValue([{ organizationId: "club-1", name: "Test Pathfinders", role: "REGISTRAR", sponsoringChurch: null }]);
    const response = await PUT(request(), ctx);
    expect(response.status).toBe(403);
    expect(mocks.reportCreate).not.toHaveBeenCalled();
  });

  it("hides other clubs", async () => {
    mocks.listDirectedClubs.mockResolvedValue([]);
    expect((await PUT(request(), ctx)).status).toBe(404);
  });

  it("refuses another club's own director", async () => {
    mocks.listDirectedClubs.mockResolvedValue([{ organizationId: "club-2", name: "Other Club", role: "DIRECTOR", sponsoringChurch: null }]);
    const response = await PUT(request(), ctx);
    expect(response.status).toBe(404);
    expect(mocks.reportCreate).not.toHaveBeenCalled();
  });
});

describe("draft and submit", () => {
  it("saves a draft with no on-time points and no first-submission time", async () => {
    const report = await saveClubReport("club-1", "2026-10", input({ status: "DRAFT" }), { accountId: "account-1" }, new Date("2026-11-05T15:00:00Z"));
    expect(report.status).toBe("DRAFT");
    expect(report.onTimePoints).toBe(0);
    expect(report.firstSubmittedAt).toBeNull();
    expect(mocks.reportCreate.mock.calls[0][0].data).toMatchObject({ status: "DRAFT", submittedAt: null, firstSubmittedAt: null, onTimePoints: 0 });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CLUB_REPORT_DRAFT_SAVED" }), client);
  });

  it("only earns on-time points, and only sets the submitter, when it is actually submitted", async () => {
    await saveClubReport("club-1", "2026-10", input({ status: "DRAFT" }), { accountId: "account-1" }, new Date("2026-11-05T15:00:00Z"));
    expect(mocks.reportCreate.mock.calls[0][0].data.submittedByAccountId).toBeUndefined();

    mocks.reportFindUnique.mockResolvedValue({ id: "report-1", status: "DRAFT", firstSubmittedAt: null });
    await saveClubReport("club-1", "2026-10", input({ status: "SUBMITTED" }), { accountId: "account-1" }, new Date("2026-11-05T16:00:00Z"));
    expect(mocks.reportUpdate.mock.calls[0][0].data).toMatchObject({ status: "SUBMITTED", onTimePoints: 25, submittedByAccountId: "account-1" });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CLUB_REPORT_SUBMITTED" }), client);
  });

  it("keeps firstSubmittedAt and on-time credit through a later edit that stays submitted", async () => {
    mocks.reportFindUnique.mockResolvedValue({ id: "report-1", status: "SUBMITTED", firstSubmittedAt: new Date("2026-11-05T15:00:00Z") });
    await saveClubReport("club-1", "2026-10", input({ status: "SUBMITTED", signatureName: "Pat Updated" }), { accountId: "account-1" }, new Date("2026-11-06T15:00:00Z"));
    expect(mocks.reportUpdate.mock.calls[0][0].data).toMatchObject({ onTimePoints: 25 });
    expect(mocks.reportUpdate.mock.calls[0][0].data).not.toHaveProperty("submittedByAccountId");
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CLUB_REPORT_UPDATED" }), client);
  });
});

describe("drafts past the due date (#426)", () => {
  const after = new Date("2026-11-12T15:00:00Z");

  it("lets a never-submitted draft go in late, with no on-time points", async () => {
    mocks.reportFindUnique.mockResolvedValue({ id: "report-1", status: "DRAFT", firstSubmittedAt: null, submittedAt: null, totalPoints: 0, onTimePoints: 0 });
    await saveClubReport("club-1", "2026-10", input(), { accountId: "account-1" }, after);
    expect(mocks.reportUpdate.mock.calls[0][0].data).toMatchObject({ status: "SUBMITTED", onTimePoints: 0, firstSubmittedAt: after });
  });

  it("lets a reopened report be resubmitted late, keeps its credit, and records the late change", async () => {
    mocks.reportFindUnique.mockResolvedValue({
      id: "report-1",
      status: "DRAFT",
      firstSubmittedAt: new Date("2026-11-05T15:00:00Z"),
      submittedAt: null,
      totalPoints: 0,
      onTimePoints: 0,
    });
    await saveClubReport("club-1", "2026-10", input(), { accountId: "account-1" }, after);
    expect(mocks.reportUpdate.mock.calls[0][0].data).toMatchObject({ status: "SUBMITTED", onTimePoints: 25, submittedAt: after });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "CLUB_REPORT_UPDATED",
      metadata: expect.objectContaining({ resubmittedAfterDueDate: true, totalPoints: 200, onTimePoints: 25 }),
    }), client);
  });

  it("saves an unsigned, half-finished draft without the point rules", async () => {
    const draft = clubReportInputSchema.parse({ points: { honors: 50 }, honors: [], status: "DRAFT" });
    await expect(saveClubReport("club-1", "2026-10", draft, { accountId: "account-1" }, new Date("2026-11-05T15:00:00Z"))).resolves.toBeTruthy();
    expect(clubReportInputSchema.safeParse({ points: { honors: 50 }, honors: [], status: "SUBMITTED" }).success).toBe(false);
  });

  it("keeps the original submitted date on a later edit that stays submitted", async () => {
    const submittedAt = new Date("2026-11-05T15:00:00Z");
    mocks.reportFindUnique.mockResolvedValue({ id: "report-1", status: "SUBMITTED", firstSubmittedAt: submittedAt, submittedAt, totalPoints: 200, onTimePoints: 25 });
    await saveClubReport("club-1", "2026-10", input(), { accountId: "account-1" }, new Date("2026-11-07T15:00:00Z"));
    expect(mocks.reportUpdate.mock.calls[0][0].data.submittedAt).toEqual(submittedAt);
    expect(mocks.writeAuditLog.mock.calls[0][0].metadata).toMatchObject({ previousTotalPoints: 200, previousOnTimePoints: 25 });
  });
});

describe("reopening a report", () => {
  it("moves a submitted report back to draft, before the due date, without touching firstSubmittedAt", async () => {
    mocks.reportFindUnique.mockResolvedValue({ id: "report-1", status: "SUBMITTED" });
    mocks.reportUpdate.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(stored({ firstSubmittedAt: new Date("2026-11-05T15:00:00Z"), ...data })));
    const report = await reopenClubReport("club-1", "2026-10", { accountId: "account-1" }, new Date("2026-11-08T15:00:00Z"));
    expect(report.status).toBe("DRAFT");
    expect(report.submittedAt).toBeNull();
    expect(mocks.reportUpdate.mock.calls[0][0].data).not.toHaveProperty("firstSubmittedAt");
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CLUB_REPORT_REOPENED" }), client);
  });

  it("refuses to reopen after the report's due date", async () => {
    mocks.reportFindUnique.mockResolvedValue({ id: "report-1", status: "SUBMITTED" });
    await expect(reopenClubReport("club-1", "2026-10", { accountId: "account-1" }, new Date("2026-11-12T15:00:00Z")))
      .rejects.toMatchObject({ code: "CLUB_REPORT_LOCKED" });
    expect(mocks.reportUpdate).not.toHaveBeenCalled();
  });

  it("refuses to reopen a report that is already a draft, or one that doesn't exist", async () => {
    mocks.reportFindUnique.mockResolvedValue({ id: "report-1", status: "DRAFT" });
    await expect(reopenClubReport("club-1", "2026-10", { accountId: "account-1" }, new Date("2026-11-08T15:00:00Z")))
      .rejects.toMatchObject({ code: "CLUB_REPORT_NOT_SUBMITTED" });

    mocks.reportFindUnique.mockResolvedValue(null);
    await expect(reopenClubReport("club-1", "2026-10", { accountId: "account-1" }, new Date("2026-11-08T15:00:00Z")))
      .rejects.toMatchObject({ code: "CLUB_REPORT_NOT_FOUND" });
  });
});

describe("the conference list hides drafts", () => {
  it("only counts SUBMITTED reports, filtering at the database query", async () => {
    mocksExtra.orgFindMany.mockResolvedValue([{ id: "club-1", name: "Test Pathfinders", parentOrganization: null }]);
    mocksExtra.reportFindMany.mockResolvedValue([
      { organizationId: "club-1", reportMonth: "2026-09", totalPoints: 300, onTimePoints: 25, firstSubmittedAt: new Date("2026-10-05T15:00:00Z") },
    ]);
    const [club] = await listClubReportsForYear("2026-27");
    expect(mocksExtra.reportFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "SUBMITTED" }),
    }));
    expect(club.reports).toEqual({ "2026-09": { totalPoints: 300, onTime: true } });
  });
});

describe("conference CSV", () => {
  it("marks past-due months missing and totals the year", () => {
    const csv = clubYearReportCsv("2026-27", [
      { name: "Test Pathfinders", church: "Test Church", registrationOnTime: true, reports: { "2026-09": { totalPoints: 300, onTime: true } } },
    ], new Date("2026-11-20T15:00:00Z"));
    const [header, row] = csv.trim().split(/\r?\n/);
    expect(header).toContain("September 2026");
    expect(row).toContain("Test Pathfinders");
    const cells = row.split(",").map((cell) => cell.replace(/^"|"$/g, ""));
    expect(cells.slice(2, 5)).toEqual(["300", "missing", ""]);
    expect(cells.slice(-3)).toEqual(["1500", "1", "1800"]);
  });
});

describe("a staff \"act as\" director gets exactly the club's rules (#442)", () => {
  const pastDue = new Date("2026-11-12T15:00:00Z");
  const acting = { userId: "admin-1", actAsId: "act-1" };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is locked out of a submitted report after the due date, like a real director", async () => {
    mocks.reportFindUnique.mockResolvedValue({ id: "report-1", status: "SUBMITTED", firstSubmittedAt: new Date("2026-11-02T15:00:00Z") });
    await expect(saveClubReport("club-1", "2026-10", input(), acting, pastDue)).rejects.toMatchObject({ code: "CLUB_REPORT_LOCKED" });
    expect(mocks.reportUpdate).not.toHaveBeenCalled();
  });

  it("records a late resubmission, attributed to the staff user and the act-as, never an attendee account", async () => {
    mocks.reportFindUnique.mockResolvedValue({
      id: "report-1",
      status: "DRAFT",
      firstSubmittedAt: new Date("2026-11-05T15:00:00Z"),
      submittedAt: null,
      totalPoints: 0,
      onTimePoints: 0,
    });
    await saveClubReport("club-1", "2026-10", input(), acting, pastDue);
    const data = mocks.reportUpdate.mock.calls[0][0].data;
    expect(data).toMatchObject({ updatedByUserId: "admin-1", updatedByAccountId: null });
    expect(data).not.toHaveProperty("submittedByAccountId");
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: "admin-1",
      metadata: expect.objectContaining({ resubmittedAfterDueDate: true, actAsId: "act-1" }),
    }), client);
    expect(mocks.writeAuditLog.mock.calls[0][0].metadata).not.toHaveProperty("actorAttendeeAccountId");
  });

  it("is refused through the club route after the due date, with no attendee account involved", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-12T15:00:00Z"));
    mocks.currentStaffActingContext.mockResolvedValue({
      userId: "admin-1", staffSessionId: "staff-session-1", actAsId: "act-1",
      role: "CLUB_DIRECTOR", organizationId: "club-1", expiresAt: new Date("2026-10-12T17:00:00Z"),
    });
    mocks.orgFindUnique.mockImplementation(({ select }: { select: Record<string, unknown> }) => Promise.resolve(
      "isActive" in select
        ? { type: "CLUB", isActive: true, name: "Test Pathfinders", parentOrganization: null }
        : { type: "CLUB", name: "Test Pathfinders" },
    ));
    mocks.reportFindUnique.mockResolvedValue({ id: "report-1", status: "SUBMITTED", firstSubmittedAt: new Date("2026-10-02T15:00:00Z") });
    const response = await PUT(new Request("https://events.imsda.test/api/attendee/clubs/club-1/reports/2026-09", {
      method: "PUT",
      headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
      body: JSON.stringify({ points: { staffMeeting: 25 }, signatureName: "Pat Example", signedOn: "2026-10-05", status: "SUBMITTED" }),
    }), { params: Promise.resolve({ organizationId: "club-1", month: "2026-09" }) });
    expect(response.status).not.toBe(200);
    expect(await response.json()).toMatchObject({ error: "CLUB_REPORT_LOCKED" });
    expect(mocks.reportUpdate).not.toHaveBeenCalled();
    expect(mocks.getCurrentAttendee).not.toHaveBeenCalled();
  });
});
