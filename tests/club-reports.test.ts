import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
  orgFindUnique: vi.fn(),
  reportFindUnique: vi.fn(),
  reportCreate: vi.fn(),
  reportUpdate: vi.fn(),
  getCurrentAttendee: vi.fn(),
  listDirectedClubs: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
}));

const client = {
  organization: { findUnique: mocks.orgFindUnique },
  clubMonthlyReport: { findUnique: mocks.reportFindUnique, create: mocks.reportCreate, update: mocks.reportUpdate },
  $transaction: (work: (tx: unknown) => unknown) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
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
import { saveClubReport } from "@/modules/club-reports/repository";
import { clubReportInputSchema } from "@/modules/club-reports/schemas";

const input = (overrides: Record<string, unknown> = {}) => clubReportInputSchema.parse({
  points: { staffMeeting: 25, meetingsOutings: 75, honors: 50, classLevel: 25 },
  honors: [{ name: "Knot Tying", participants: 8 }, { name: "Camping Skills I", participants: 6 }],
  classLevels: ["FRIEND", "COMPANION"],
  signatureName: "Pat Example",
  signedOn: "2026-11-05",
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
  mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "account-1", verifiedEmail: "r@example.test", displayName: "R" }, via: "attendee", sessionId: "s-1" });
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
    mocks.reportFindUnique.mockResolvedValue({ id: "report-1", firstSubmittedAt: new Date("2026-11-02T15:00:00Z") });
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
    body: JSON.stringify({ points: { staffMeeting: 25 }, signatureName: "Pat Example", signedOn: "2026-10-05" }),
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
