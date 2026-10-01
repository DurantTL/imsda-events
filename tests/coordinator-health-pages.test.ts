import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveStaffHealthViewer: vi.fn(),
  resolveAreaHealthViewer: vi.fn(),
  clubLeaderHealthViewerFromAccess: vi.fn(),
  getRosterAccessStateForPage: vi.fn(),
  loadEventHealth: vi.fn(),
  listHealthEvents: vi.fn(),
  resolveEventContext: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: vi.fn() }));
vi.mock("@/modules/coordinator-health/access", () => ({
  resolveStaffHealthViewer: mocks.resolveStaffHealthViewer,
  resolveAreaHealthViewer: mocks.resolveAreaHealthViewer,
  clubLeaderHealthViewerFromAccess: mocks.clubLeaderHealthViewerFromAccess,
}));
vi.mock("@/modules/coordinator-health/repository", () => ({
  HealthViewError: class HealthViewError extends Error { constructor(public readonly code: string, message: string) { super(message); } },
  loadEventHealth: mocks.loadEventHealth,
  listHealthEvents: mocks.listHealthEvents,
}));
vi.mock("@/modules/events/selection", () => ({ resolveEventContext: mocks.resolveEventContext }));
vi.mock("@/modules/club-rosters/access", () => ({ getRosterAccessStateForPage: mocks.getRosterAccessStateForPage }));

import AreaHealthPage from "@/app/(public)/account/(portal)/area/health/page";
import ClubHealthPage from "@/app/(public)/account/(portal)/clubs/[organizationId]/health/page";
import StaffEventHealthPage from "@/app/(workspace)/more/event-health/page";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveEventContext.mockResolvedValue({ event: { id: "e1" } });
});

describe("every health page checks access itself on the server (#658)", () => {
  it("staff page: a user without the grant (or signed out) sees the restricted notice and nothing is loaded", async () => {
    mocks.resolveStaffHealthViewer.mockResolvedValue(null);
    const element = await StaffEventHealthPage({ searchParams: Promise.resolve({ event: "e1" }) });
    expect(JSON.stringify(element)).toContain("Health information is restricted");
    expect(mocks.loadEventHealth).not.toHaveBeenCalled();
  });

  it("Area Coordinator page: anyone who is not an Area Coordinator past the second step gets 404 and nothing is loaded", async () => {
    mocks.resolveAreaHealthViewer.mockResolvedValue(null);
    await expect(AreaHealthPage({ searchParams: Promise.resolve({ event: "e1" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(AreaHealthPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.loadEventHealth).not.toHaveBeenCalled();
    expect(mocks.listHealthEvents).not.toHaveBeenCalled();
  });

  it("club page: no open roster access renders nothing; a registrar or reporter is told it is for directors", async () => {
    mocks.getRosterAccessStateForPage.mockResolvedValue({ state: "NOT_FOUND" });
    expect(await ClubHealthPage({ params: Promise.resolve({ organizationId: "club-b" }), searchParams: Promise.resolve({ event: "e1" }) })).toBeNull();
    mocks.getRosterAccessStateForPage.mockResolvedValue({ state: "OPEN", club: { role: "REGISTRAR" } });
    mocks.clubLeaderHealthViewerFromAccess.mockReturnValue(null);
    const element = await ClubHealthPage({ params: Promise.resolve({ organizationId: "club-a" }), searchParams: Promise.resolve({ event: "e1" }) });
    expect(JSON.stringify(element)).toContain("director and deputy");
    expect(mocks.loadEventHealth).not.toHaveBeenCalled();
  });

  it("club page: a director's request is always scoped to their own club (no club parameter is passed)", async () => {
    const viewer = { kind: "CLUB_LEADER", organizationId: "club-a", actor: { kind: "ATTENDEE", accountId: "a" } };
    mocks.getRosterAccessStateForPage.mockResolvedValue({ state: "OPEN", club: { role: "DIRECTOR" } });
    mocks.clubLeaderHealthViewerFromAccess.mockReturnValue(viewer);
    mocks.loadEventHealth.mockResolvedValue({ event: { id: "e1", name: "Synthetic", availableThrough: "2026-11-10" }, purpose: "VIEW", clubs: [] });
    await ClubHealthPage({ params: Promise.resolve({ organizationId: "club-a" }), searchParams: Promise.resolve({ event: "e1" }) });
    expect(mocks.loadEventHealth).toHaveBeenCalledWith(viewer, "e1", { purpose: "VIEW" });
  });

  it("the printable sheet loads as an export, so it is audited as one", async () => {
    mocks.resolveAreaHealthViewer.mockResolvedValue({ kind: "AREA_COORDINATOR", accountId: "acct-ac" });
    mocks.loadEventHealth.mockResolvedValue({ event: { id: "e1", name: "Synthetic", availableThrough: "2026-11-10" }, purpose: "EXPORT", clubs: [] });
    await AreaHealthPage({ searchParams: Promise.resolve({ event: "e1", sheet: "1" }) });
    expect(mocks.loadEventHealth).toHaveBeenCalledWith({ kind: "AREA_COORDINATOR", accountId: "acct-ac" }, "e1", { organizationId: undefined, purpose: "EXPORT" });
  });
});
