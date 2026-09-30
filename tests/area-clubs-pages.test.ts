import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Page-level denial for the Area Coordinator Clubs section (#657): layouts do
 * not re-run on navigation, so each page must refuse by itself. The real
 * coordinator check runs; only the session, database and summary data are stubbed.
 */
const mocks = vi.hoisted(() => ({
  areaGrantFindUnique: vi.fn(),
  getCurrentAttendee: vi.fn(),
  accountNeedsSecondStep: vi.fn(),
  currentStaffActingContext: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
  getAreaClubsSummary: vi.fn(),
  listAreaClubEvents: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({ areaCoordinatorGrant: { findUnique: mocks.areaGrantFindUnique } }) }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/attendee-accounts/sign-in-gate", () => ({ accountNeedsSecondStep: mocks.accountNeedsSecondStep }));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: mocks.currentStaffActingContext }));
vi.mock("@/modules/club-reports/area-summary-repository", () => ({
  getAreaClubsSummary: mocks.getAreaClubsSummary,
  listAreaClubEvents: mocks.listAreaClubEvents,
}));

import AreaLayout from "@/app/(public)/account/(portal)/area-clubs/layout";
import EventsPage from "@/app/(public)/account/(portal)/area-clubs/events/page";
import OverviewPage from "@/app/(public)/account/(portal)/area-clubs/overview/page";
import PointsPage from "@/app/(public)/account/(portal)/area-clubs/points/page";
import ReportsPage from "@/app/(public)/account/(portal)/area-clubs/reports/page";

const pages = { overview: OverviewPage, reports: ReportsPage, points: PointsPage, events: EventsPage };
const props = { searchParams: Promise.resolve({}) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "account-1" }, via: "attendee", sessionId: "s1" });
  mocks.areaGrantFindUnique.mockResolvedValue({ revokedAt: null, expiresAt: null });
  mocks.accountNeedsSecondStep.mockResolvedValue("OK");
  mocks.currentStaffActingContext.mockResolvedValue(null);
  mocks.getAreaClubsSummary.mockResolvedValue([]);
  mocks.listAreaClubEvents.mockResolvedValue([]);
});

describe.each(Object.entries(pages))("area-clubs %s page (#657)", (_name, Page) => {
  it("renders for an active Area Coordinator", async () => {
    await expect(Page(props)).resolves.toBeTruthy();
  });

  it.each([
    ["a non-coordinator", () => mocks.areaGrantFindUnique.mockResolvedValue(null)],
    ["a revoked grant", () => mocks.areaGrantFindUnique.mockResolvedValue({ revokedAt: new Date("2026-01-01"), expiresAt: null })],
    ["an expired grant", () => mocks.areaGrantFindUnique.mockResolvedValue({ revokedAt: null, expiresAt: new Date("2020-01-01") })],
    ["a pending second step", () => mocks.accountNeedsSecondStep.mockResolvedValue("VERIFY")],
    ["a signed-out visitor", () => mocks.getCurrentAttendee.mockResolvedValue({ account: null, via: null, sessionId: null })],
  ])("returns not found for %s without loading any club data", async (_label, arrange) => {
    arrange();
    await expect(Page(props)).rejects.toThrow("NOT_FOUND");
    expect(mocks.getAreaClubsSummary).not.toHaveBeenCalled();
    expect(mocks.listAreaClubEvents).not.toHaveBeenCalled();
  });
});

describe("area-clubs layout (#657)", () => {
  it("still refuses a non-coordinator", async () => {
    mocks.areaGrantFindUnique.mockResolvedValue(null);
    await expect(AreaLayout({ children: null })).rejects.toThrow("NOT_FOUND");
  });
});
