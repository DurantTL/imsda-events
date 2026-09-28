import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireClubCapability: vi.fn(),
  currentAreaCoordinatorViewerActive: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/club-rosters/access", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-rosters/access")>("@/modules/club-rosters/access");
  return { ...actual, requireClubCapability: mocks.requireClubCapability };
});
vi.mock("@/modules/organizations/area-coordinators", () => ({
  currentAreaCoordinatorViewerActive: mocks.currentAreaCoordinatorViewerActive,
}));

import { RosterAccessError } from "@/modules/club-rosters/access";
import { requireHonorsAccess, requireHonorsEditAccess } from "@/modules/honors/member-honor-access";

describe("honors access — club roles that can edit the roster vs. Area Coordinators", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("gives a director (roster-capable role) edit access", async () => {
    mocks.currentAreaCoordinatorViewerActive.mockResolvedValue(false);
    mocks.requireClubCapability.mockResolvedValue({ actor: { kind: "ATTENDEE", accountId: "acct-1", sessionId: "s1" } });
    const access = await requireHonorsAccess("club-1");
    expect(access).toEqual({ mode: "EDIT", actor: { accountId: "acct-1" } });
    expect(mocks.requireClubCapability).toHaveBeenCalledWith("club-1", "roster", expect.any(Date));
  });

  it("gives an Area Coordinator read-only access without ever checking the club role", async () => {
    mocks.currentAreaCoordinatorViewerActive.mockResolvedValue(true);
    const access = await requireHonorsAccess("club-1");
    expect(access).toEqual({ mode: "READ" });
    expect(mocks.requireClubCapability).not.toHaveBeenCalled();
  });

  it("denies a role without roster access (e.g. a reporter), same as the roster itself", async () => {
    mocks.currentAreaCoordinatorViewerActive.mockResolvedValue(false);
    mocks.requireClubCapability.mockRejectedValue(new RosterAccessError("ROLE_NOT_ALLOWED", 403, "Your club role doesn't include this."));
    await expect(requireHonorsAccess("club-1")).rejects.toMatchObject({ code: "ROLE_NOT_ALLOWED", status: 403 });
  });

  it("requireHonorsEditAccess never grants a mere viewer edit access", async () => {
    mocks.requireClubCapability.mockRejectedValue(new RosterAccessError("ROLE_NOT_ALLOWED", 403, "Your club role doesn't include this."));
    await expect(requireHonorsEditAccess("club-1")).rejects.toMatchObject({ code: "ROLE_NOT_ALLOWED" });
  });

  it("attributes a staff act-as director's edit to the staff user, not an attendee account", async () => {
    mocks.currentAreaCoordinatorViewerActive.mockResolvedValue(false);
    mocks.requireClubCapability.mockResolvedValue({
      actor: { kind: "STAFF_ACTING", userId: "user-9", staffSessionId: "sess-1", actAsId: "actas-1", organizationId: "club-1" },
    });
    const access = await requireHonorsAccess("club-1");
    expect(access).toEqual({ mode: "EDIT", actor: { userId: "user-9", actAsId: "actas-1" } });
  });
});
