import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  orgFindMany: vi.fn(),
  reportFindMany: vi.fn(),
  standingFindMany: vi.fn(),
  rosterGroupBy: vi.fn(),
  grantFindMany: vi.fn(),
  eventFindMany: vi.fn(),
  areaGrantFindUnique: vi.fn(),
  getCurrentAttendee: vi.fn(),
  accountNeedsSecondStep: vi.fn(),
  currentStaffActingContext: vi.fn(),
  getCurrentSession: vi.fn(),
  complianceCounts: vi.fn(),
}));

const client = {
  organization: { findMany: mocks.orgFindMany },
  clubMonthlyReport: { findMany: mocks.reportFindMany },
  clubYearStanding: { findMany: mocks.standingFindMany },
  clubRosterMember: { groupBy: mocks.rosterGroupBy },
  clubDirectorGrant: { findMany: mocks.grantFindMany },
  event: { findMany: mocks.eventFindMany },
  areaCoordinatorGrant: { findUnique: mocks.areaGrantFindUnique },
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/attendee-accounts/sign-in-gate", () => ({ accountNeedsSecondStep: mocks.accountNeedsSecondStep }));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: mocks.currentStaffActingContext }));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/background-checks/repository", () => ({ clubsComplianceReminderCounts: mocks.complianceCounts }));

import { GET as ADMIN_EXPORT } from "@/app/api/admin/club-reports/area-export/route";
import { GET as AREA_EXPORT } from "@/app/api/attendee/area-clubs/export/route";
import {
  areaPointsCsv,
  areaSummaryCsv,
  eventHeadcount,
  monthCell,
  parseLeaderboardSort,
  pointsChartDescription,
  registrationStatusFor,
  sortLeaderboard,
  summarizeClub,
  type AreaSummaryInput,
} from "@/modules/club-reports/area-summary-domain";
import { getAreaClubsSummary, listAreaClubEvents } from "@/modules/club-reports/area-summary-repository";
import { yearToDate } from "@/modules/club-reports/domain";

// 2026-11-20 noon UTC: September's report is past due (Oct 10), October's is past due (Nov 10), November is not yet.
const now = new Date("2026-11-20T18:00:00Z");

const input = (overrides: Partial<AreaSummaryInput> = {}): AreaSummaryInput => ({
  id: "club-a",
  name: "Alpha Pathfinders",
  church: "First Church",
  directors: ["Dana Director"],
  rosterSize: 12,
  registrationOnTime: true,
  backgroundChecks: { missing: 1, notInCompliance: 2, expiringSoon: 3 },
  reports: [
    { reportMonth: "2026-09", status: "SUBMITTED", totalPoints: 300, onTimePoints: 25 },
    { reportMonth: "2026-10", status: "SUBMITTED", totalPoints: 200, onTimePoints: 0 },
    { reportMonth: "2026-11", status: "DRAFT", totalPoints: 0, onTimePoints: 0 },
  ],
  ...overrides,
});

describe("area club summary domain (#657)", () => {
  it("classifies every month as submitted, late, draft, missing, due, or not yet due", () => {
    const club = summarizeClub(input({ reports: input().reports.filter((report) => report.reportMonth !== "2026-09") }), "2026-27", now);
    const statuses = Object.fromEntries(club.months.map((cell) => [cell.month, cell.status]));
    expect(statuses["2026-09"]).toBe("MISSING");
    expect(statuses["2026-10"]).toBe("LATE");
    expect(statuses["2026-11"]).toBe("DRAFT");
    expect(statuses["2026-12"]).toBe("FUTURE");
    expect(monthCell("2026-11", undefined, now).status).toBe("DUE");
    expect(club.months).toHaveLength(12);
  });

  it("totals match the per-club report data and the club's own year-to-date figure", () => {
    const source = input();
    const club = summarizeClub(source, "2026-27", now);
    expect(club.submitted).toBe(2);
    expect(club.late).toBe(1);
    expect(club.drafts).toBe(1);
    expect(club.missing).toBe(0);
    expect(club.lastReportMonth).toBe("2026-10");
    expect(club.reportPoints).toBe(500);
    // A draft earns nothing; registration adds 1,500; same number the club overview shows.
    expect(club.totalPoints).toBe(yearToDate(source.reports.filter((report) => report.status === "SUBMITTED"), true));
    expect(club.totalPoints).toBe(2000);
    expect(summarizeClub(input({ registrationOnTime: false }), "2026-27", now).totalPoints).toBe(500);
    expect(summarizeClub(input({ reports: [] }), "2026-27", now).lastReportMonth).toBeNull();
  });

  it("sorts the leaderboard by points or name without mutating the input", () => {
    const clubs = [
      { name: "Bravo", totalPoints: 10 },
      { name: "Alpha", totalPoints: 10 },
      { name: "Charlie", totalPoints: 30 },
    ];
    expect(sortLeaderboard(clubs, "points").map((club) => club.name)).toEqual(["Charlie", "Alpha", "Bravo"]);
    expect(sortLeaderboard(clubs, "name").map((club) => club.name)).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(clubs[0]!.name).toBe("Bravo");
    expect(parseLeaderboardSort("name")).toBe("name");
    expect(parseLeaderboardSort("anything")).toBe("points");
  });

  it("describes the chart in text, including the empty case", () => {
    expect(pointsChartDescription([{ name: "Alpha", totalPoints: 1500 }, { name: "Bravo", totalPoints: 20 }], "2026-27"))
      .toContain("Highest: Alpha with 1,500 points");
    expect(pointsChartDescription([], "2026-27")).toBe("No active clubs for 2026-27.");
  });

  it("exports the summary and points as CSV with the same numbers", () => {
    const club = summarizeClub(input(), "2026-27", now);
    const summary = areaSummaryCsv("2026-27", [club]).split("\r\n");
    expect(summary[0]).toContain("Total points");
    expect(summary[1]).toContain('"300"');
    expect(summary[1]).toContain('"200 (late)"');
    expect(summary[1]).toContain('"draft"');
    expect(summary[1]!.endsWith('"500","1500","2000"')).toBe(true);
    const points = areaPointsCsv("2026-27", [club]).split("\r\n");
    expect(points[1]).toBe('"1","Alpha Pathfinders","First Church","2026-27","500","1500","2000"');
    // Counts only: no background-check columns, names, or notes in either export.
    expect(summary.join("\n")).not.toMatch(/background|Dana/i);
  });

  it("maps registration statuses and counts only registered headcount", () => {
    expect(registrationStatusFor(null)).toBe("NOT_REGISTERED");
    expect(registrationStatusFor("CONFIRMED")).toBe("REGISTERED");
    expect(registrationStatusFor("SUBMITTED")).toBe("REGISTERED");
    expect(registrationStatusFor("WAITLISTED")).toBe("WAITLISTED");
    expect(registrationStatusFor("CANCELLED")).toBe("CANCELLED");
    expect(eventHeadcount([
      { organizationId: "a", name: "A", status: "REGISTERED", headcount: 10 },
      { organizationId: "b", name: "B", status: "WAITLISTED", headcount: 7 },
      { organizationId: "c", name: "C", status: "NOT_REGISTERED", headcount: null },
    ])).toBe(10);
  });
});

describe("area club summary repository (#657)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.orgFindMany.mockResolvedValue([
      { id: "club-a", name: "Alpha Pathfinders", parentOrganization: { name: "First Church" } },
      { id: "club-b", name: "Bravo Adventurers", parentOrganization: null },
    ]);
    mocks.reportFindMany.mockResolvedValue([
      { organizationId: "club-a", reportMonth: "2026-09", status: "SUBMITTED", totalPoints: 300, onTimePoints: 25 },
      { organizationId: "club-b", reportMonth: "2026-09", status: "DRAFT", totalPoints: 50, onTimePoints: 0 },
    ]);
    mocks.standingFindMany.mockResolvedValue([{ organizationId: "club-a", registrationOnTime: true }]);
    mocks.rosterGroupBy.mockResolvedValue([{ organizationId: "club-a", _count: { _all: 12 } }]);
    mocks.grantFindMany.mockResolvedValue([
      { organizationId: "club-a", effectiveFrom: new Date("2026-01-01"), effectiveTo: null, revokedAt: null, attendeeAccount: { displayName: "Dana Director" } },
    ]);
    mocks.complianceCounts.mockResolvedValue(new Map([
      ["club-a", { missing: 1, notInCompliance: 2, expiringSoon: 3 }],
      ["club-b", { missing: 0, notInCompliance: 0, expiringSoon: 0 }],
    ]));
  });

  it("builds one row per active club from the stored reports, with counts-only Sterling Volunteers", async () => {
    const clubs = await getAreaClubsSummary("2026-27", now);
    expect(clubs.map((club) => club.name)).toEqual(["Alpha Pathfinders", "Bravo Adventurers"]);
    const [alpha, bravo] = clubs;
    expect(alpha).toMatchObject({ directors: ["Dana Director"], rosterSize: 12, church: "First Church", totalPoints: 1800, submitted: 1 });
    expect(alpha!.backgroundChecks).toEqual({ missing: 1, notInCompliance: 2, expiringSoon: 3 });
    // A draft counts as a draft with no points, and its unfiled September is not "missing".
    expect(bravo).toMatchObject({ rosterSize: 0, drafts: 1, totalPoints: 0, directors: [], church: "" });
    expect(JSON.stringify(clubs)).not.toMatch(/issuesNote|reasons|email/);
    // One batched query for all clubs, not one per club.
    expect(mocks.complianceCounts).toHaveBeenCalledTimes(1);
  });

  it("skips the background-check query when the caller does not show counts", async () => {
    const clubs = await getAreaClubsSummary("2026-27", now, { backgroundChecks: false });
    expect(mocks.complianceCounts).not.toHaveBeenCalled();
    expect(clubs[0]!.backgroundChecks).toEqual({ missing: 0, notInCompliance: 0, expiringSoon: 0 });
  });

  it("limits events to the club year on both ends", async () => {
    mocks.eventFindMany.mockResolvedValue([]);
    await listAreaClubEvents("2025-26");
    const where = mocks.eventFindMany.mock.calls[0]![0].where;
    expect(where.endsAt).toEqual({ gte: new Date("2025-09-01T00:00:00Z") });
    expect(where.startsAt).toEqual({ lt: new Date("2026-09-01T00:00:00Z") });
  });

  it("lists club events with each club's registration status and headcount", async () => {
    mocks.eventFindMany.mockResolvedValue([
      {
        id: "event-1",
        name: "Fall Camporee",
        startsAt: new Date("2026-10-09T00:00:00Z"),
        clubRegistrations: [{ organizationId: "club-a", registration: { status: "CONFIRMED", _count: { attendees: 22 } } }],
        clubRegistrationDrafts: [{ organizationId: "club-b" }],
      },
    ]);
    const [event] = await listAreaClubEvents("2026-27");
    expect(event!.clubs).toEqual([
      { organizationId: "club-a", name: "Alpha Pathfinders", status: "REGISTERED", headcount: 22 },
      { organizationId: "club-b", name: "Bravo Adventurers", status: "DRAFT", headcount: null },
    ]);
  });
});

describe("area club export permissions (#657)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.orgFindMany.mockResolvedValue([{ id: "club-a", name: "Alpha Pathfinders", parentOrganization: null }]);
    mocks.reportFindMany.mockResolvedValue([]);
    mocks.standingFindMany.mockResolvedValue([]);
    mocks.rosterGroupBy.mockResolvedValue([]);
    mocks.grantFindMany.mockResolvedValue([]);
    mocks.complianceCounts.mockResolvedValue({ missing: 0, notInCompliance: 0, expiringSoon: 0 });
    mocks.accountNeedsSecondStep.mockResolvedValue("OK");
    mocks.currentStaffActingContext.mockResolvedValue(null);
  });

  const request = (path: string, query = "report=summary&year=2026-27") => new Request(`https://events.test${path}?${query}`);

  it("lets an Area Coordinator download the summary and points", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "account-1" }, via: "attendee", sessionId: "s1" });
    mocks.areaGrantFindUnique.mockResolvedValue({ revokedAt: null, expiresAt: null });
    const summary = await AREA_EXPORT(request("/api/attendee/area-clubs/export"));
    expect(summary.status).toBe(200);
    expect(summary.headers.get("Content-Type")).toContain("text/csv");
    expect(await summary.text()).toContain("Alpha Pathfinders");
    const points = await AREA_EXPORT(request("/api/attendee/area-clubs/export", "report=points&year=2026-27"));
    expect((await points.text()).split("\r\n")[0]).toContain("Rank");
  });

  it("lets a staff member acting as an Area Coordinator download it too", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account: null, via: null, sessionId: null });
    mocks.currentStaffActingContext.mockResolvedValue({ role: "AREA_COORDINATOR" });
    expect((await AREA_EXPORT(request("/api/attendee/area-clubs/export"))).status).toBe(200);
  });

  it("refuses a club director who is not an Area Coordinator, and a signed-out visitor", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "director-1" }, via: "attendee", sessionId: "s1" });
    mocks.areaGrantFindUnique.mockResolvedValue(null);
    expect((await AREA_EXPORT(request("/api/attendee/area-clubs/export"))).status).toBe(404);
    mocks.getCurrentAttendee.mockResolvedValue({ account: null, via: null, sessionId: null });
    expect((await AREA_EXPORT(request("/api/attendee/area-clubs/export"))).status).toBe(404);
    expect(mocks.orgFindMany).not.toHaveBeenCalled();
  });

  it("refuses a revoked or expired Area Coordinator grant", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "account-1" }, via: "attendee", sessionId: "s1" });
    mocks.areaGrantFindUnique.mockResolvedValue({ revokedAt: new Date("2026-01-01"), expiresAt: null });
    expect((await AREA_EXPORT(request("/api/attendee/area-clubs/export"))).status).toBe(404);
    mocks.areaGrantFindUnique.mockResolvedValue({ revokedAt: null, expiresAt: new Date("2020-01-01") });
    expect((await AREA_EXPORT(request("/api/attendee/area-clubs/export"))).status).toBe(404);
  });

  it("refuses a coordinator who has not passed the second sign-in step", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "account-1" }, via: "attendee", sessionId: "s1" });
    mocks.areaGrantFindUnique.mockResolvedValue({ revokedAt: null, expiresAt: null });
    mocks.accountNeedsSecondStep.mockResolvedValue("VERIFY");
    expect((await AREA_EXPORT(request("/api/attendee/area-clubs/export"))).status).toBe(404);
  });

  it("gives the staff export to system administrators only", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "u1", globalRole: "SYSTEM_ADMIN" } });
    expect((await ADMIN_EXPORT(request("/api/admin/club-reports/area-export"))).status).toBe(200);
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "u2", globalRole: "STAFF" } });
    expect((await ADMIN_EXPORT(request("/api/admin/club-reports/area-export"))).status).toBe(403);
    mocks.getCurrentSession.mockResolvedValue({ user: null });
    expect((await ADMIN_EXPORT(request("/api/admin/club-reports/area-export"))).status).toBe(401);
  });
});
