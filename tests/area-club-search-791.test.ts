import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Area Coordinator club search and the points default sort (#791). The filter
 * and sort helpers are tested directly; the pages are rendered with the real
 * coordinator check and stubbed summary data, all synthetic.
 */
const mocks = vi.hoisted(() => ({
  areaGrantFindUnique: vi.fn(),
  getCurrentAttendee: vi.fn(),
  accountNeedsSecondStep: vi.fn(),
  currentStaffActingContext: vi.fn(),
  getAreaClubsSummary: vi.fn(),
  listAreaClubEvents: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); }, redirect: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({ areaCoordinatorGrant: { findUnique: mocks.areaGrantFindUnique } }) }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/attendee-accounts/sign-in-gate", () => ({ accountNeedsSecondStep: mocks.accountNeedsSecondStep }));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: mocks.currentStaffActingContext }));
vi.mock("@/modules/club-reports/area-summary-repository", () => ({
  getAreaClubsSummary: mocks.getAreaClubsSummary,
  listAreaClubEvents: mocks.listAreaClubEvents,
}));

import { AreaPointsChart } from "@/components/area-clubs-views";
import EventsPage from "@/app/(public)/account/(portal)/area-clubs/events/page";
import OverviewPage from "@/app/(public)/account/(portal)/area-clubs/overview/page";
import PointsPage from "@/app/(public)/account/(portal)/area-clubs/points/page";
import ReportsPage from "@/app/(public)/account/(portal)/area-clubs/reports/page";
import {
  filterClubsByName,
  parseClubQuery,
  parseLeaderboardSort,
  sortLeaderboard,
  type AreaClubSummary,
} from "@/modules/club-reports/area-summary-domain";

function club(id: string, name: string, totalPoints: number): AreaClubSummary {
  return {
    id, name, church: "Test Church", directors: [], rosterSize: 10, registrationOnTime: true, submitted: 0, late: 0, drafts: 0, missing: 0,
    lastReportMonth: null, reportPoints: totalPoints, totalPoints, months: [], backgroundChecks: { notInCompliance: 0, expiringSoon: 0, missing: 0 },
  } as unknown as AreaClubSummary;
}

const clubs = [club("a", "Alpine Eagles", 900), club("b", "Bay Trailblazers", 2400), club("c", "Cedar Ridge", 1500), club("d", "Delta Eagles", 1500)];

describe("club name filter (#791)", () => {
  it("keeps clubs whose name contains the text, ignoring case and extra spaces", () => {
    expect(filterClubsByName(clubs, "eagles").map((c) => c.id)).toEqual(["a", "d"]);
    expect(filterClubsByName(clubs, "  CEDAR   ridge ").map((c) => c.id)).toEqual(["c"]);
  });

  it("keeps every club for a blank or missing search, and never mutates the input", () => {
    const input = [...clubs];
    expect(filterClubsByName(input, "")).toHaveLength(4);
    expect(filterClubsByName(input, "   ")).toHaveLength(4);
    expect(filterClubsByName(input, undefined)).toHaveLength(4);
    expect(filterClubsByName(input, "zzz")).toEqual([]);
    expect(input).toEqual(clubs);
  });

  it("trims and caps the search text from the address", () => {
    expect(parseClubQuery("  Eagles ")).toBe("Eagles");
    expect(parseClubQuery(["Cedar", "x"])).toBe("Cedar");
    expect(parseClubQuery(undefined)).toBe("");
    expect(parseClubQuery("x".repeat(200))).toHaveLength(80);
  });
});

describe("points default sort (#791)", () => {
  it("defaults to points unless the address asks for name", () => {
    expect(parseLeaderboardSort(undefined)).toBe("points");
    expect(parseLeaderboardSort("bogus")).toBe("points");
    expect(parseLeaderboardSort("name")).toBe("name");
  });

  it("orders highest first, ties by name", () => {
    expect(sortLeaderboard(clubs, "points").map((c) => c.id)).toEqual(["b", "c", "d", "a"]);
  });

  it("renders highest first and says so", () => {
    const html = renderToStaticMarkup(createElement(AreaPointsChart, { basePath: "/account/area-clubs/points", clubYear: "2026-27", clubs, sort: "points" }));
    expect(html).toContain("Sorted by total points, highest first.");
    expect(html.indexOf("Bay Trailblazers")).toBeLessThan(html.indexOf("Cedar Ridge"));
    expect(html.indexOf("Cedar Ridge")).toBeLessThan(html.indexOf("Alpine Eagles"));
  });

  it("says when it is sorted by name", () => {
    const html = renderToStaticMarkup(createElement(AreaPointsChart, { basePath: "/account/area-clubs/points", clubYear: "2026-27", clubs, sort: "name" }));
    expect(html).toContain("Sorted by club name, A to Z.");
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "account-1" }, via: "attendee", sessionId: "s1" });
  mocks.areaGrantFindUnique.mockResolvedValue({ revokedAt: null, expiresAt: null });
  mocks.accountNeedsSecondStep.mockResolvedValue("OK");
  mocks.currentStaffActingContext.mockResolvedValue(null);
  mocks.getAreaClubsSummary.mockResolvedValue(clubs);
  mocks.listAreaClubEvents.mockResolvedValue([
    { id: "e1", name: "Test Camporee", startsAt: "2026-10-10T00:00:00.000Z", clubs: [
      { organizationId: "a", name: "Alpine Eagles", status: "REGISTERED", headcount: 12 },
      { organizationId: "b", name: "Bay Trailblazers", status: "REGISTERED", headcount: 20 },
    ] },
  ]);
});

const html = async (Page: (props: { searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>, search: Record<string, string>) =>
  renderToStaticMarkup(await Page({ searchParams: Promise.resolve(search) }));

describe.each([
  ["overview", OverviewPage],
  ["reports", ReportsPage],
  ["points", PointsPage],
  ["events", EventsPage],
] as const)("area-clubs %s page club search (#791)", (name, Page) => {
  it("shows a search box and every club without a search", async () => {
    const out = await html(Page, {});
    expect(out).toContain('name="q"');
    if (name === "events") expect(out).toContain("Bay Trailblazers");
  });

  it("filters to matching clubs and says how many match", async () => {
    const out = await html(Page, { q: "alpine" });
    expect(out).toContain("Alpine Eagles");
    expect(out).not.toContain("Bay Trailblazers");
    expect(out).toContain("1 of ");
    expect(out).toContain("clubs match");
  });

  it("says so when no club matches", async () => {
    const out = await html(Page, { q: "nothing here" });
    expect(out).toContain("No club name matches");
  });
});

describe("rank and event totals under a search (#791)", () => {
  it("keeps a club's overall rank and the bar scale when searched", async () => {
    const out = await html(PointsPage, { q: "alpine" });
    expect(out).toContain('data-label="Rank">4<');
    expect(out).toContain('width="37.5"'); // 900 of the unfiltered maximum 2,400
    expect(out).not.toContain("Bay Trailblazers");
  });

  it("keeps an event's registered clubs and people whole while a search narrows the rows", async () => {
    const out = await html(EventsPage, { q: "alpine" });
    expect(out).toContain("Alpine Eagles");
    expect(out).not.toContain("Bay Trailblazers");
    expect(out).toMatch(/2 clubs registered/);
    expect(out).toContain("32 people");
  });
});

describe("points page default order (#791)", () => {
  it("lists the highest total first with no sort in the address", async () => {
    const out = await html(PointsPage, {});
    expect(out).toContain("Sorted by total points, highest first.");
    expect(out.indexOf("Bay Trailblazers")).toBeLessThan(out.indexOf("Alpine Eagles"));
  });
});
