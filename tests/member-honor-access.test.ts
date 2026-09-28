import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireRosterAccess: vi.fn(),
  requireClubCapability: vi.fn(),
  currentAreaCoordinator: vi.fn(),
  currentStaffActingContext: vi.fn(),
  findOrganization: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({ organization: { findUnique: mocks.findOrganization } }) }));
vi.mock("@/modules/club-rosters/access", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-rosters/access")>("@/modules/club-rosters/access");
  return { ...actual, requireRosterAccess: mocks.requireRosterAccess, requireClubCapability: mocks.requireClubCapability };
});
vi.mock("@/modules/organizations/area-coordinators", () => ({ currentAreaCoordinator: mocks.currentAreaCoordinator }));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: mocks.currentStaffActingContext }));

import { RosterAccessError } from "@/modules/club-rosters/access";
import { requireHonorsAccess, requireHonorsEditAccess } from "@/modules/honors/member-honor-access";

const notFound = () => new RosterAccessError("NOT_FOUND", 404, "That club could not be found.");

describe("honors access — the roster's own gate first, Area Coordinator read-only as a fallback", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.currentAreaCoordinator.mockResolvedValue(null);
    mocks.currentStaffActingContext.mockResolvedValue(null);
    mocks.findOrganization.mockResolvedValue({ type: "CLUB", isActive: true });
  });

  it("gives a director with an open roster edit access, through requireRosterAccess (never requireClubCapability)", async () => {
    mocks.requireRosterAccess.mockResolvedValue({ state: "OPEN", actor: { kind: "ATTENDEE", accountId: "acct-1", sessionId: "s1" } });
    await expect(requireHonorsAccess("club-1")).resolves.toEqual({ mode: "EDIT", actor: { accountId: "acct-1" } });
    expect(mocks.requireRosterAccess).toHaveBeenCalledWith("club-1", expect.any(Date));
    expect(mocks.requireClubCapability).not.toHaveBeenCalled();
    expect(mocks.currentAreaCoordinator).not.toHaveBeenCalled();
  });

  it("gives an Area Coordinator with no club role here read-only access", async () => {
    mocks.requireRosterAccess.mockRejectedValue(notFound());
    mocks.currentAreaCoordinator.mockResolvedValue({ id: "acct-ac" });
    await expect(requireHonorsAccess("club-1")).resolves.toEqual({ mode: "READ", viewer: { accountId: "acct-ac" } });
  });

  it("gives a staff act-as Area Coordinator (no attendee session) read-only access, attributed to the staff user", async () => {
    mocks.requireRosterAccess.mockRejectedValue(new RosterAccessError("SIGN_IN_REQUIRED", 401, "Sign in."));
    mocks.currentStaffActingContext.mockResolvedValue({ role: "AREA_COORDINATOR", userId: "user-9", actAsId: "actas-2" });
    await expect(requireHonorsAccess("club-1")).resolves.toEqual({ mode: "READ", viewer: { userId: "user-9", actAsId: "actas-2" } });
  });

  it("404s an Area Coordinator for an organization that isn't an active club", async () => {
    mocks.requireRosterAccess.mockRejectedValue(notFound());
    mocks.currentAreaCoordinator.mockResolvedValue({ id: "acct-ac" });
    for (const organization of [null, { type: "CHURCH", isActive: true }, { type: "CLUB", isActive: false }]) {
      mocks.findOrganization.mockResolvedValue(organization);
      await expect(requireHonorsAccess("org-x")).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    }
  });

  it("never falls back to Area Coordinator read access past a club role's MFA or role denial", async () => {
    mocks.currentAreaCoordinator.mockResolvedValue({ id: "acct-ac" });
    for (const code of ["MFA_SETUP_REQUIRED", "MFA_UNLOCK_REQUIRED", "ROLE_NOT_ALLOWED"] as const) {
      mocks.requireRosterAccess.mockRejectedValue(new RosterAccessError(code, 403, "Denied."));
      await expect(requireHonorsAccess("club-1")).rejects.toMatchObject({ code, status: 403 });
    }
  });

  it("keeps the 404 for someone who is neither a club role nor an Area Coordinator", async () => {
    mocks.requireRosterAccess.mockRejectedValue(notFound());
    await expect(requireHonorsAccess("club-1")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("requireHonorsEditAccess never grants an Area Coordinator edit access", async () => {
    mocks.requireRosterAccess.mockRejectedValue(notFound());
    mocks.currentAreaCoordinator.mockResolvedValue({ id: "acct-ac" });
    await expect(requireHonorsEditAccess("club-1")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("attributes a staff act-as director's edit to the staff user, not an attendee account", async () => {
    mocks.requireRosterAccess.mockResolvedValue({
      state: "OPEN",
      actor: { kind: "STAFF_ACTING", userId: "user-9", staffSessionId: "sess-1", actAsId: "actas-1", organizationId: "club-1" },
    });
    await expect(requireHonorsAccess("club-1")).resolves.toEqual({ mode: "EDIT", actor: { userId: "user-9", actAsId: "actas-1" } });
  });
});
