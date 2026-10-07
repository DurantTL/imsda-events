import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The club-year dashboard (#488): the director's own club home and the
 * shared staff/Area Coordinator overview both build the same at-a-glance
 * tiles (roster, honors, Sterling Volunteers, events, monthly reports) from
 * data they already load — no new queries. These tests walk each server
 * page's returned tree (the same walk the roster page tests use)
 * and check the `ClubYearTiles` props each role gets, without rendering to DOM.
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
  listClubHonorsPage: vi.fn(),
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
vi.mock("@/modules/honors/member-honor-repository", () => ({ listClubHonorsPage: mocks.listClubHonorsPage }));

import ClubHomePage from "@/app/(public)/account/(portal)/clubs/[organizationId]/page";
import { ClubOverview } from "@/components/club-overview";
import { ClubRosterWorkspace } from "@/components/club-roster-workspace";
import { ClubYearTiles } from "@/components/club-year-tiles";

type AnyProps = Record<string, unknown>;

/** Every component element in a rendered server tree, depth first — the same walk the roster page tests use. */
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

/** `listClubHonorsPage` rows (#486): one in-progress honor and one completed this club year, plus one completed years ago. */
const honorRows = [
  {
    memberId: "member-1", firstName: "Dana", lastName: "Pathfinder", classLevel: "FRIEND",
    honors: [
      { honorId: "honor-1", honorCode: "H1", honorName: "Camping Skills I", status: "IN_PROGRESS", completionDate: "", createdAt: "2026-10-01T00:00:00.000Z" },
      { honorId: "honor-2", honorCode: "H2", honorName: "Knot Tying", status: "COMPLETED", completionDate: "2026-10-05", createdAt: "2026-10-05T00:00:00.000Z" },
    ],
  },
  {
    memberId: "member-2", firstName: "Sam", lastName: "Pathfinder", classLevel: "RANGER",
    honors: [
      { honorId: "honor-3", honorCode: "H3", honorName: "First Aid", status: "COMPLETED", completionDate: "2020-05-01", createdAt: "2020-05-01T00:00:00.000Z" },
    ],
  },
];

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
  mocks.listClubHonorsPage.mockResolvedValue(honorRows);
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
    // No background-check tile on club home (#644): those problems are red to-dos instead.
    expect(props.compliance).toBeNull();
    // One in-progress honor, and one of two completed honors falls inside this club year (started 2026-09-01).
    expect(props.honors).toEqual({ inProgress: 1, completedThisYear: 1 });
    expect(props.events).toEqual({ open: 1, registered: 1 });
    // September is filed. October is past its own Nov 10 due date, so it's missing; November
    // (the current month, due Dec 10) isn't missing yet — it's "due soon" instead (review fix).
    expect(props.reports).toEqual({ filed: 1, missing: 1, dueSoon: { count: 1, dueDate: "2026-12-10" } });
    expect(props.rosterHref).toBe("/account/clubs/club-1/roster");
    expect(props.eventsHref).toBe("/account/clubs/club-1/events");
    expect(props.reportsHref).toBe("/account/clubs/club-1/records");
    expect(props.honorsHref).toBe("/account/clubs/club-1/honors");

    // The existing "What's next" list stays.
    const headings = allElements(tree).filter((element) => element.type === "h2").map((element) => element.props.children);
    expect(headings).toContain("To do");
  });

  it("shows background-check problems only as red to-dos, and nothing when none are due (#644)", async () => {
    mocks.getRosterAccessStateForPage.mockResolvedValue({
      state: "OPEN",
      club: { organizationId: "club-1", name: "Test Pathfinders", role: "DIRECTOR", sponsoringChurch: null },
      capabilities: { roster: true, registerForEvents: true, seeBirthDates: true, manageTeam: true, editProfile: true, submitReports: true },
      actor: { kind: "ATTENDEE", accountId: "account-1", sessionId: "session-1" },
    });
    const dangerItems = (tree: ReactNode) => allElements(tree).filter((element) => element.type === "li" && element.props.className === "club-step-danger");

    mocks.clubPortalComplianceReminderCounts.mockResolvedValue({ notInCompliance: 1, expiringSoon: 0, missing: 2 });
    const withProblems = await ClubHomePage({ params: Promise.resolve({ organizationId: "club-1" }) });
    expect(dangerItems(withProblems)).toHaveLength(2);
    expect(tilesProps(withProblems).compliance).toBeNull();

    mocks.clubPortalComplianceReminderCounts.mockResolvedValue({ notInCompliance: 0, expiringSoon: 0, missing: 0 });
    const clean = await ClubHomePage({ params: Promise.resolve({ organizationId: "club-1" }) });
    expect(dangerItems(clean)).toHaveLength(0);
  });

  it("doesn't call an unfiled month missing before it's due — matching 'What's next' on the same page (review fix)", async () => {
    mocks.getRosterAccessStateForPage.mockResolvedValue({
      state: "OPEN",
      club: { organizationId: "club-1", name: "Test Pathfinders", role: "DIRECTOR", sponsoringChurch: null },
      capabilities: { roster: true, registerForEvents: true, seeBirthDates: true, manageTeam: true, editProfile: true, submitReports: true },
      actor: { kind: "ATTENDEE", accountId: "account-1", sessionId: "session-1" },
    });
    mocks.clubPortalComplianceReminderCounts.mockResolvedValue(null);
    // Nothing filed yet, and no report is even due until October 10 for September.
    mocks.getClubReportYear.mockResolvedValue(reportYear([]));
    vi.setSystemTime(new Date("2026-09-28T18:00:00.000Z"));

    const tree = await ClubHomePage({ params: Promise.resolve({ organizationId: "club-1" }) });
    const props = tilesProps(tree);
    expect(props.reports).toEqual({ filed: 0, missing: 0, dueSoon: { count: 1, dueDate: "2026-10-10" } });
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
    // The roster, honors, and events tiles are unaffected by the registrar's narrower access:
    // honors (#486) are visible to anyone who can view the roster, which a registrar can.
    expect(props.roster.active).toBe(3);
    expect(props.honors).toEqual({ inProgress: 1, completedThisYear: 1 });
    expect(props.honorsHref).toBe("/account/clubs/club-1/honors");
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
    expect(props.honors).toEqual({ inProgress: 1, completedThisYear: 1 });
    // No Honors page for this viewer, and the roster no longer lists honors, so the tile has no link (#819).
    expect(props.honorsHref).toBeUndefined();
    expect(props.events).toEqual({ open: 1, registered: 1 });
    expect(props.reports).toEqual({ filed: 1, missing: 1, dueSoon: { count: 1, dueDate: "2026-12-10" } });
  });

  it("gives an Area Coordinator the same tiles, counts only, with no names anywhere in the tree", async () => {
    const tree = await ClubOverview({
      organizationId: "club-1",
      honorsHref: "/account/area/club-1/honors",
      reportHref: (month) => `/account/area/club-1/reports/${month}`,
      reportsEditable: false,
      complianceCounts: true,
    });
    const props = tilesProps(tree);
    expect(props.compliance).toEqual({ notInCompliance: 0, expiringSoon: 0, missing: 1 });
    expect(mocks.clubRosterComplianceStatuses).not.toHaveBeenCalled();
    expect(props.roster.active).toBe(3);
    expect(props.honors).toEqual({ inProgress: 1, completedThisYear: 1 });
    expect(props.events).toEqual({ open: 1, registered: 1 });
    expect(props.reports).toEqual({ filed: 1, missing: 1, dueSoon: { count: 1, dueDate: "2026-12-10" } });

    // Every tile links to an anchor on this same read-only page, not a separate route staff can't reach here —
    // except honors, which has its own read-only Area Coordinator page (#486).
    expect(props.rosterHref).toBe("#open-club-roster");
    expect(props.eventsHref).toBe("#open-club-events");
    expect(props.reportsHref).toBe("#open-club-reports");
    expect(props.honorsHref).toBe("/account/area/club-1/honors");
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
    // Honors are visible to anyone who can view the roster (#486), even without background-check access.
    expect(props.honors).toEqual({ inProgress: 1, completedThisYear: 1 });
    expect(props.honorsHref).toBeUndefined();
  });
});

describe("the staff overview's roster year (#541)", () => {
  const staffOverview = (rosterYear?: string) => ClubOverview({
    organizationId: "club-1",
    birthDatesEndpoint: "/api/admin/organizations/club-1/roster/birth-dates",
    reportHref: (month) => `/admin/clubs/reports/club-1/${month}`,
    reportsEditable: true,
    backgroundChecks: { includeNotes: true },
    rosterYear,
  });
  const rosterProps = (tree: ReactNode) => {
    const element = componentElements(tree).find((candidate) => candidate.type === ClubRosterWorkspace);
    expect(element).toBeDefined();
    // Keyed by year: a client-side year change must remount it, not keep last year's people.
    expect(element!.key).toBe(element!.props.clubYear);
    return element!.props;
  };

  it("shows another year's roster read-only, with no birth-date reveal", async () => {
    const props = rosterProps(await staffOverview("2025-26"));
    expect(mocks.listRoster).toHaveBeenCalledWith("club-1", "2025-26", expect.any(Date));
    expect(mocks.clubRosterComplianceStatuses).toHaveBeenCalledWith("club-1", "2025-26", { includeNotes: true });
    expect(mocks.listClubHonorsPage).toHaveBeenCalledWith("club-1", "2025-26");
    // Reports stay on the current club year.
    expect(mocks.getClubReportYear).toHaveBeenCalledWith("club-1", "2026-27");
    expect(props).toMatchObject({ clubYear: "2025-26", readOnly: true, canSeeBirthDates: false, birthDatesEndpoint: undefined });
  });

  it("keeps the current year's birth-date reveal", async () => {
    const props = rosterProps(await staffOverview("2026-27"));
    expect(props).toMatchObject({ clubYear: "2026-27", readOnly: true, canSeeBirthDates: true, birthDatesEndpoint: "/api/admin/organizations/club-1/roster/birth-dates" });
    expect(rosterProps(await staffOverview())).toMatchObject({ clubYear: "2026-27", canSeeBirthDates: true });
  });
});

describe("the note reaches an Area Coordinator's roster and never a director's (#443)", () => {
  const adult = {
    id: "adult-1", firstName: "Pat", lastName: "Pathfinder", attendeeType: "ADULT", role: "", classLevel: null, gender: null,
    status: "ACTIVE", source: "DIRECTOR", age: 30, reportedAge: null, birthDateNeeded: false, updatedAt: "2026-09-01T00:00:00.000Z",
  };
  const rosterHtml = async (backgroundChecks: { includeNotes: boolean }) => {
    mocks.listRoster.mockResolvedValue([adult]);
    // Like the real repository: the note only comes back when it was asked for.
    mocks.clubRosterComplianceStatuses.mockImplementation(async (_org: string, _year: string, options: { includeNotes: boolean }) => ({
      statuses: { "adult-1": { state: "NOT_COMPLIANT", note: options.includeNotes ? "Synthetic note for the coordinator" : null, reasons: [] } },
      notInCompliance: 1, expiringSoon: 0, missing: 0,
    }));
    const tree = await ClubOverview({
      organizationId: "club-1", honorsHref: "/account/area/club-1/honors", reportHref: () => "#", reportsEditable: false, backgroundChecks,
    });
    const roster = componentElements(tree).find((element) => element.type === ClubRosterWorkspace);
    expect(roster).toBeDefined();
    return renderToStaticMarkup(createElement(ClubRosterWorkspace, roster!.props as Parameters<typeof ClubRosterWorkspace>[0]));
  };

  it("renders each adult's status and the full note for an Area Coordinator", async () => {
    const html = await rosterHtml({ includeNotes: true });
    expect(html).toContain("Not in compliance");
    expect(html).toContain("Synthetic note for the coordinator");
  });

  it("renders the status without any note when notes are not allowed", async () => {
    const html = await rosterHtml({ includeNotes: false });
    expect(html).toContain("Not in compliance");
    expect(html).not.toContain("Synthetic note");
  });
});
