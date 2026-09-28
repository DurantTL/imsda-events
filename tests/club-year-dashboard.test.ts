import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The club-year dashboard (#488): the director's own club home and the
 * shared staff/Area Coordinator overview both build the same at-a-glance
 * tiles (roster, background checks, events, monthly reports) from data they
 * already load — no new queries. These tests walk each server page's
 * returned tree (the pattern from `driver-verification-pages.test.ts`) and
 * check the `ClubYearTiles` props each role gets, without rendering to DOM.
 */

const mocks = vi.hoisted(() => ({
  getRosterAccessStateForPage: vi.fn(),
  getCurrentAttendee: vi.fn(),
  listDirectedClubs: vi.fn(),
  listRoster: vi.fn(),
  listClubEvents: vi.fn(),
  getClubReportYear: vi.fn(),
  clubPortalComplianceReminderCounts: vi.fn(),
  clubComplianceReminderCounts: vi.fn(),
  clubRosterComplianceStatuses: vi.fn(),
  listClubTeam: vi.fn(),
  redirect: vi.fn((to: string) => { throw new Error(`REDIRECT ${to}`); }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/modules/club-rosters/access", () => ({ getRosterAccessStateForPage: mocks.getRosterAccessStateForPage }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: mocks.listDirectedClubs }));
vi.mock("@/modules/club-rosters/repository", () => ({ listRoster: mocks.listRoster }));
vi.mock("@/modules/club-registrations/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-registrations/repository")>("@/modules/club-registrations/repository");
  return { ...actual, listClubEvents: mocks.listClubEvents };
});
vi.mock("@/modules/club-reports/repository", () => ({ getClubReportYear: mocks.getClubReportYear }));
vi.mock("@/modules/background-checks/repository", () => ({
  clubPortalComplianceReminderCounts: mocks.clubPortalComplianceReminderCounts,
  clubComplianceReminderCounts: mocks.clubComplianceReminderCounts,
  clubRosterComplianceStatuses: mocks.clubRosterComplianceStatuses,
}));
vi.mock("@/modules/organizations/director-grants-repository", () => ({ listClubTeam: mocks.listClubTeam }));

import ClubHomePage from "@/app/(public)/account/(portal)/clubs/[organizationId]/page";
import { ClubOverview } from "@/components/club-overview";
import { ClubYearTiles } from "@/components/club-year-tiles";

type AnyProps = Record<string, unknown>;

/** Every component element in a rendered server tree, depth first — same walk as the driver-verification page tests. */
function componentElements(node: ReactNode, found: ReactElement<AnyProps>[] = []) {
  if (Array.isArray(node)) {
    for (const child of node) componentElements(child, found);
    return found;
  }
  if (!isValidElement<AnyProps>(node)) return found;
  if (typeof node.type === "function") found.push(node);
  componentElements(node.props.children as ReactNode, found);
  return found;
}

/** Every element (host tags included), for checking plain markup like the "What's next" heading stays. */
function allElements(node: ReactNode, found: ReactElement<AnyProps>[] = []) {
  if (Array.isArray(node)) {
    for (const child of node) allElements(child, found);
    return found;
  }
  if (!isValidElement<AnyProps>(node)) return found;
  found.push(node);
  allElements(node.props.children as ReactNode, found);
  return found;
}

function tilesProps(tree: ReactNode) {
  const tiles = componentElements(tree).find((element) => element.type === ClubYearTiles);
  expect(tiles).toBeDefined();
  return tiles!.props as Parameters<typeof ClubYearTiles>[0];
}

/** A minimal roster member, matching what `listRoster` returns. */
const member = (overrides: Record<string, unknown> = {}) => ({
  id: `member-${Math.random()}`,
  status: "ACTIVE",
  attendeeType: "YOUTH",
  classLevel: "FRIEND",
  ...overrides,
});

const members = [
  member({ attendeeType: "STAFF", classLevel: null }),
  member({ attendeeType: "YOUTH", classLevel: "FRIEND" }),
  member({ attendeeType: "YOUTH", classLevel: "RANGER" }),
];

const openEvent = {
  id: "event-open", name: "Fall Camporee", startsAt: "2026-10-10T00:00:00.000Z", endsAt: "2026-10-12T00:00:00.000Z",
  timezone: "America/Chicago", location: "Camp Kulaqua", phase: "OPEN", registrationClosesOn: null,
  available: true, problem: null, registration: null, draft: null,
};
const registeredEvent = {
  ...openEvent, id: "event-registered", name: "Winter Retreat", phase: "CLOSED",
  registration: { confirmationCode: "ABC123", status: "CONFIRMED", attendeeCount: 5, amountOwedCents: 0 },
};

const reportYear = (reports: Array<{ reportMonth: string; status: string; totalPoints?: number }> = []) => ({
  reports: reports.map((report) => ({
    id: `report-${report.reportMonth}`, organizationId: "club-1", clubYear: "2026-27", reportMonth: report.reportMonth,
    status: report.status, totalPoints: report.totalPoints ?? 100, points: {}, honors: [], classLevels: [],
    meetingPlace: "", meetingSchedule: "", averageAttendance: null, pathfinderCount: null, tltCount: null, staffCount: null,
    investitureDate: null, onTimePoints: 25, signatureName: "", signedOn: null, submittedAt: null, firstSubmittedAt: null,
    updatedAt: new Date().toISOString(),
  })),
  registrationOnTime: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listRoster.mockResolvedValue(members);
  mocks.listClubEvents.mockResolvedValue([openEvent, registeredEvent]);
  mocks.getClubReportYear.mockResolvedValue(reportYear([{ reportMonth: "2026-09", status: "SUBMITTED" }]));
  mocks.listDirectedClubs.mockResolvedValue([]);
  mocks.getCurrentAttendee.mockResolvedValue({ account: null, via: null, sessionId: null });
  mocks.listClubTeam.mockResolvedValue([]);
  mocks.clubRosterComplianceStatuses.mockResolvedValue({ statuses: {}, notInCompliance: 1, expiringSoon: 2, missing: 3 });
  mocks.clubComplianceReminderCounts.mockResolvedValue({ notInCompliance: 0, expiringSoon: 0, missing: 1 });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-15T18:00:00.000Z"));
});

describe("the club home page builds the director's tiles (#488)", () => {
  it("gives a director the roster breakdown, background-check counts, events, and reports, linking to each page", async () => {
    mocks.getRosterAccessStateForPage.mockResolvedValue({
      state: "OPEN",
      club: { organizationId: "club-1", name: "Test Pathfinders", role: "DIRECTOR", sponsoringChurch: null },
      capabilities: { roster: true, registerForEvents: true, seeBirthDates: true, manageTeam: true, editProfile: true, submitReports: true },
      actor: { kind: "ATTENDEE", accountId: "account-1", sessionId: "session-1" },
    });
    mocks.clubPortalComplianceReminderCounts.mockResolvedValue({ notInCompliance: 1, expiringSoon: 0, missing: 2 });

    const tree = await ClubHomePage({ params: Promise.resolve({ organizationId: "club-1" }) });
    const props = tilesProps(tree);

    expect(props.roster).toEqual({
      active: 3, staff: 1, members: 2,
      byClass: [{ classLevel: "FRIEND", label: "Friend", count: 1 }, { classLevel: "RANGER", label: "Ranger", count: 1 }],
    });
    expect(props.compliance).toEqual({ notInCompliance: 1, expiringSoon: 0, missing: 2 });
    expect(props.events).toEqual({ open: 1, registered: 1 });
    // The September report is filed; October and November (due so far) are not.
    expect(props.reports).toEqual({ filed: 1, missing: 2 });
    expect(props.rosterHref).toBe("/account/clubs/club-1/roster");
    expect(props.eventsHref).toBe("/account/clubs/club-1/events");
    expect(props.reportsHref).toBe("/account/clubs/club-1/reports");

    // The existing "What's next" list stays.
    const headings = allElements(tree).filter((element) => element.type === "h2").map((element) => element.props.children);
    expect(headings).toContain("To do");
  });

  it("hides the background-check and reports tiles for a registrar, who doesn't get either (#375)", async () => {
    mocks.getRosterAccessStateForPage.mockResolvedValue({
      state: "OPEN",
      club: { organizationId: "club-1", name: "Test Pathfinders", role: "REGISTRAR", sponsoringChurch: null },
      capabilities: { roster: true, registerForEvents: true, seeBirthDates: false, manageTeam: false, editProfile: false, submitReports: false },
      actor: { kind: "ATTENDEE", accountId: "account-2", sessionId: "session-2" },
    });
    mocks.clubPortalComplianceReminderCounts.mockResolvedValue(null);

    const tree = await ClubHomePage({ params: Promise.resolve({ organizationId: "club-1" }) });
    const props = tilesProps(tree);
    expect(props.compliance).toBeNull();
    expect(props.reports).toBeNull();
    // The roster and events tiles are unaffected by the registrar's narrower access.
    expect(props.roster.active).toBe(3);
    expect(props.events).toEqual({ open: 1, registered: 1 });
  });

  it("shows a reporter no roster or tiles at all, only monthly reports (#375)", async () => {
    mocks.getRosterAccessStateForPage.mockResolvedValue({
      state: "NO_ROSTER",
      club: { organizationId: "club-1", name: "Test Pathfinders", role: "REPORTER", sponsoringChurch: null },
      capabilities: { roster: false, registerForEvents: false, seeBirthDates: false, manageTeam: false, editProfile: false, submitReports: true },
    });
    const tree = await ClubHomePage({ params: Promise.resolve({ organizationId: "club-1" }) });
    expect(componentElements(tree).some((element) => element.type === ClubYearTiles)).toBe(false);
  });
});

describe("the shared club overview gives staff and Area Coordinators the same read-only tiles (#488)", () => {
  it("gives a staff \"Open club\" viewer background-check counts derived from the full per-member statuses", async () => {
    const tree = await ClubOverview({
      organizationId: "club-1",
      birthDatesEndpoint: "/api/admin/organizations/club-1/roster/birth-dates",
      reportHref: (month) => `/admin/clubs/reports/club-1/${month}`,
      reportsEditable: true,
      backgroundChecks: { includeNotes: true },
    });
    const props = tilesProps(tree);
    expect(props.roster).toEqual({
      active: 3, staff: 1, members: 2,
      byClass: [{ classLevel: "FRIEND", label: "Friend", count: 1 }, { classLevel: "RANGER", label: "Ranger", count: 1 }],
    });
    // Counts only, from the per-member compliance statuses staff already see with names — never a second query.
    expect(props.compliance).toEqual({ notInCompliance: 1, expiringSoon: 2, missing: 3 });
    expect(mocks.clubComplianceReminderCounts).not.toHaveBeenCalled();
    expect(props.events).toEqual({ open: 1, registered: 1 });
    expect(props.reports).toEqual({ filed: 1, missing: 2 });
  });

  it("gives an Area Coordinator the same tiles, counts only, with no names anywhere in the tree", async () => {
    const tree = await ClubOverview({
      organizationId: "club-1",
      reportHref: (month) => `/account/area/club-1/reports/${month}`,
      reportsEditable: false,
      complianceCounts: true,
    });
    const props = tilesProps(tree);
    expect(props.compliance).toEqual({ notInCompliance: 0, expiringSoon: 0, missing: 1 });
    expect(mocks.clubRosterComplianceStatuses).not.toHaveBeenCalled();
    expect(props.roster.active).toBe(3);
    expect(props.events).toEqual({ open: 1, registered: 1 });
    expect(props.reports).toEqual({ filed: 1, missing: 2 });

    // Every tile links to an anchor on this same read-only page, not a separate route staff can't reach here.
    expect(props.rosterHref).toBe("#open-club-roster");
    expect(props.eventsHref).toBe("#open-club-events");
    expect(props.reportsHref).toBe("#open-club-reports");
  });

  it("hides the background-check tile for a viewer allowed neither names nor counts (an event manager)", async () => {
    const tree = await ClubOverview({
      organizationId: "club-1",
      reportHref: (month) => `/more/clubs/reports/club-1/${month}`,
      reportsEditable: false,
    });
    const props = tilesProps(tree);
    expect(props.compliance).toBeNull();
    expect(mocks.clubRosterComplianceStatuses).not.toHaveBeenCalled();
    expect(mocks.clubComplianceReminderCounts).not.toHaveBeenCalled();
  });
});
