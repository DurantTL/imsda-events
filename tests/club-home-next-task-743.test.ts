import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #743 Club home: the next task and its deadline come before the statistics,
 * and the club menu keeps its order. Synthetic data only.
 */
const mocks = vi.hoisted(() => ({
  getRosterAccessStateForPage: vi.fn(),
  getCurrentAttendee: vi.fn(),
  listDirectedClubs: vi.fn(),
  listRoster: vi.fn(),
  listClubEvents: vi.fn(),
  getClubReportYear: vi.fn(),
  clubPortalComplianceReminderCounts: vi.fn(),
  listClubHonorsPage: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/modules/club-rosters/access", () => ({ getRosterAccessStateForPage: mocks.getRosterAccessStateForPage }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: mocks.listDirectedClubs }));
vi.mock("@/modules/club-rosters/repository", () => ({ listRoster: mocks.listRoster }));
vi.mock("@/modules/club-registrations/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-registrations/repository")>("@/modules/club-registrations/repository");
  return { ...actual, listClubEvents: mocks.listClubEvents };
});
vi.mock("@/modules/club-reports/repository", () => ({ getClubReportYear: mocks.getClubReportYear }));
vi.mock("@/modules/background-checks/repository", () => ({ clubPortalComplianceReminderCounts: mocks.clubPortalComplianceReminderCounts }));
vi.mock("@/modules/honors/member-honor-repository", () => ({ listClubHonorsPage: mocks.listClubHonorsPage }));

import ClubHomePage from "@/app/(public)/account/(portal)/clubs/[organizationId]/page";
import { ClubNextTaskCard } from "@/components/club-next-task";
import { ClubYearTiles } from "@/components/club-year-tiles";
import { pickClubNextTask } from "@/modules/club-rosters/home-next-task";
import { areaClubPortalNavItems, clubPortalNavItems } from "@/modules/club-rosters/portal-nav";

type AnyProps = Record<string, unknown>;
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

const director = {
  state: "OPEN",
  club: { organizationId: "club-1", name: "Test Pathfinders", role: "DIRECTOR", sponsoringChurch: null },
  capabilities: { roster: true, registerForEvents: true, seeBirthDates: true, manageTeam: true, editProfile: true, submitReports: true },
  actor: { kind: "ATTENDEE", accountId: "account-1", sessionId: "session-1" },
};
const openEvent = {
  id: "event-open", name: "Fall Camporee", startsAt: "2026-10-10T00:00:00.000Z", endsAt: "2026-10-12T00:00:00.000Z",
  timezone: "America/Chicago", location: "Camp Fixture", phase: "OPEN", registrationClosesOn: "2026-12-01",
  available: true, problem: null, registration: null, draft: null,
};
const activeMember = { id: "member-1", status: "ACTIVE", attendeeType: "YOUTH", classLevel: "FRIEND" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRosterAccessStateForPage.mockResolvedValue(director);
  mocks.listRoster.mockResolvedValue([activeMember]);
  mocks.listClubEvents.mockResolvedValue([openEvent]);
  mocks.getClubReportYear.mockResolvedValue({ reports: [{ reportMonth: "2026-09", status: "SUBMITTED" }], registrationOnTime: false });
  mocks.listDirectedClubs.mockResolvedValue([]);
  mocks.getCurrentAttendee.mockResolvedValue({ account: null, via: null, sessionId: null });
  mocks.clubPortalComplianceReminderCounts.mockResolvedValue(null);
  mocks.listClubHonorsPage.mockResolvedValue([]);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-15T18:00:00.000Z"));
});

describe("Club home shows the next task and its deadline before the statistics", () => {
  it("renders the Next task card before the year tiles, with the one filled button", async () => {
    const tree = await ClubHomePage({ params: Promise.resolve({ organizationId: "club-1" }) });
    const order = componentElements(tree).map((element) => element.type);
    expect(order.indexOf(ClubNextTaskCard)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(ClubNextTaskCard)).toBeLessThan(order.indexOf(ClubYearTiles));
  });

  it("names the first task and its deadline: a report due date, then an event closing date", async () => {
    // September is unfiled and due October 10, which is still ahead.
    mocks.getClubReportYear.mockResolvedValue({ reports: [], registrationOnTime: false });
    vi.setSystemTime(new Date("2026-10-05T18:00:00.000Z"));
    const tree = await ClubHomePage({ params: Promise.resolve({ organizationId: "club-1" }) });
    const card = componentElements(tree).find((element) => element.type === ClubNextTaskCard)!;
    const next = card.props.next as ReturnType<typeof pickClubNextTask>;
    expect(next?.step.key).toBe("report-2026-09");
    expect(next?.deadline).toBe("Due October 10");
    const html = renderToStaticMarkup(ClubNextTaskCard({ next }) as ReactElement);
    expect(html).toContain("Next task");
    expect(html).toContain("Due October 10");
    expect(html).toContain("Open report");
    expect(html.match(/class="primary-button/g)).toHaveLength(1);
  });

  it("falls to the event closing date when nothing else is due", async () => {
    const tree = await ClubHomePage({ params: Promise.resolve({ organizationId: "club-1" }) });
    const card = componentElements(tree).find((element) => element.type === ClubNextTaskCard)!;
    const next = card.props.next as ReturnType<typeof pickClubNextTask>;
    expect(next?.step.key).toBe("event-open");
    expect(next?.deadline).toBe("Register by December 1, 2026");
  });

  it("picks the first step, says No deadline when it has none, and keeps the rest for the list", () => {
    const steps = [
      { key: "roster", text: "Add your club members.", href: "/r", action: "Add people" },
      { key: "event-1", text: "Register.", href: "/e", action: "Register" },
    ];
    const next = pickClubNextTask(steps, { "event-1": "Register by May 1" });
    expect(next?.step.key).toBe("roster");
    expect(next?.deadline).toBeNull();
    expect(next?.others.map((step) => step.key)).toEqual(["event-1"]);
    expect(renderToStaticMarkup(ClubNextTaskCard({ next }) as ReactElement)).toContain("No deadline");
    expect(pickClubNextTask([], {})).toBeNull();
    expect(renderToStaticMarkup(ClubNextTaskCard({ next: null }) as ReactElement)).toContain("all caught up");
  });

  it("leaves only secondary buttons in the To do list, so the page keeps one filled button", async () => {
    const tree = await ClubHomePage({ params: Promise.resolve({ organizationId: "club-1" }) });
    const actions = allElements(tree).filter((element) => String(element.props.className ?? "").includes("club-event-action"));
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.some((element) => String(element.props.className).includes("primary-button"))).toBe(false);
  });
});

describe("the club menu order is unchanged", () => {
  const capabilities = { roster: true, registerForEvents: true, seeBirthDates: true, manageTeam: true, editProfile: true, submitReports: true, guardians: true };
  it("keeps the director's menu in its order", () => {
    expect(clubPortalNavItems({ base: "/account/clubs/c", role: "DIRECTOR", capabilities }).map((item) => item.label)).toEqual([
      "Home", "Roster", "Honors", "Class tracking", "Club events", "Forms", "Health", "Monthly Records", "Orders", "Club settings",
    ]);
  });
  it("keeps the Area Coordinator's menu in its order", () => {
    expect(areaClubPortalNavItems({ organizationId: "c" }).map((item) => item.label)).toEqual([
      "Home", "Roster", "Honors", "Events", "Club forms", "Monthly reports", "Orders", "Earned awards",
    ]);
  });
});
