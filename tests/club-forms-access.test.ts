import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  membershipFindMany: vi.fn(),
  requireRosterAccess: vi.fn(),
  currentAreaCoordinator: vi.fn(),
  currentStaffActingContext: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({ eventMembership: { findMany: mocks.membershipFindMany } }) }));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/club-rosters/access", () => ({ requireRosterAccess: mocks.requireRosterAccess }));
vi.mock("@/modules/organizations/area-coordinators", () => ({ currentAreaCoordinator: mocks.currentAreaCoordinator }));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: mocks.currentStaffActingContext }));

import {
  clubLeaderViewerFromAccess,
  requireClubLeaderViewer,
  requireStaffViewer,
  resolveAreaCoordinatorViewer,
  resolveStaffViewer,
  staffClubFormsAccess,
} from "@/modules/club-forms/access";
import {
  clubFormLinkState,
  clampLinkDays,
  isClubFormsRole,
  viewerAuditFields,
  viewerCanRevealSensitive,
  viewerCanSeeClub,
  viewerCanWriteForClub,
  viewerSeesDisabledTemplates,
  viewerSeesDrafts,
  type ClubFormsViewer,
} from "@/modules/club-forms/domain";

const director: ClubFormsViewer = { kind: "CLUB_LEADER", organizationId: "club-a", actor: { kind: "ATTENDEE", accountId: "acct-1" } };
const actingDirector: ClubFormsViewer = { kind: "CLUB_LEADER", organizationId: "club-a", actor: { kind: "STAFF_ACTING", userId: "admin-1", actAsId: "act-1" } };
const areaCoordinator: ClubFormsViewer = { kind: "AREA_COORDINATOR", actor: { kind: "ATTENDEE", accountId: "acct-2" } };
const staffWithSensitive: ClubFormsViewer = { kind: "STAFF", userId: "staff-1", canViewSensitive: true };
const staffWithout: ClubFormsViewer = { kind: "STAFF", userId: "staff-2", canViewSensitive: false };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("club forms role matrix (#610)", () => {
  it("lets only the club's own director or deputy write", () => {
    expect(viewerCanWriteForClub(director, "club-a")).toBe(true);
    expect(viewerCanWriteForClub(actingDirector, "club-a")).toBe(true);
    expect(viewerCanWriteForClub(director, "club-b")).toBe(false);
    for (const viewer of [areaCoordinator, staffWithSensitive, staffWithout]) {
      expect(viewerCanWriteForClub(viewer, "club-a")).toBe(false);
    }
  });

  it("keeps a club's director to their own club", () => {
    expect(viewerCanSeeClub(director, "club-a")).toBe(true);
    expect(viewerCanSeeClub(director, "club-b")).toBe(false);
    for (const viewer of [areaCoordinator, staffWithSensitive, staffWithout]) expect(viewerCanSeeClub(viewer, "club-b")).toBe(true);
  });

  it("shows sensitive answers to the club's leaders and to staff with VIEW_SENSITIVE_DATA only", () => {
    expect(viewerCanRevealSensitive(director, "club-a")).toBe(true);
    expect(viewerCanRevealSensitive(director, "club-b")).toBe(false);
    expect(viewerCanRevealSensitive(actingDirector, "club-a")).toBe(true);
    expect(viewerCanRevealSensitive(staffWithSensitive, "club-b")).toBe(true);
    expect(viewerCanRevealSensitive(staffWithout, "club-b")).toBe(false);
    expect(viewerCanRevealSensitive(areaCoordinator, "club-a")).toBe(false);
  });

  it("hides disabled templates from clubs and Area Coordinators, and drafts from everyone but the club", () => {
    expect(viewerSeesDisabledTemplates(director)).toBe(false);
    expect(viewerSeesDisabledTemplates(areaCoordinator)).toBe(false);
    expect(viewerSeesDisabledTemplates(staffWithout)).toBe(true);
    expect(viewerSeesDrafts(director)).toBe(true);
    expect(viewerSeesDrafts(areaCoordinator)).toBe(false);
    expect(viewerSeesDrafts(staffWithSensitive)).toBe(false);
  });

  it("only director and deputy roles use club forms", () => {
    expect(isClubFormsRole("DIRECTOR")).toBe(true);
    expect(isClubFormsRole("DEPUTY")).toBe(true);
    expect(isClubFormsRole("REGISTRAR")).toBe(false);
    expect(isClubFormsRole("REPORTER")).toBe(false);
  });

  it("attributes audit rows to the right person and never to an attendee for a staff act-as", () => {
    expect(viewerAuditFields(director)).toEqual({ metadata: { viewerKind: "CLUB_LEADER", actorAttendeeAccountId: "acct-1" } });
    expect(viewerAuditFields(actingDirector)).toEqual({ actorUserId: "admin-1", metadata: { viewerKind: "CLUB_LEADER", actAsId: "act-1" } });
    expect(viewerAuditFields(staffWithout)).toEqual({ actorUserId: "staff-2", metadata: { viewerKind: "STAFF" } });
  });
});

describe("link state and lifetime", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  it("derives expiry from the date and leaves used and withdrawn links as they are", () => {
    const later = new Date("2026-10-02T00:00:00Z");
    const earlier = new Date("2026-09-30T00:00:00Z");
    expect(clubFormLinkState({ status: "OPEN", expiresAt: later }, now)).toBe("OPEN");
    expect(clubFormLinkState({ status: "OPEN", expiresAt: earlier }, now)).toBe("EXPIRED");
    expect(clubFormLinkState({ status: "OPEN", expiresAt: now }, now)).toBe("EXPIRED");
    expect(clubFormLinkState({ status: "USED", expiresAt: earlier }, now)).toBe("USED");
    expect(clubFormLinkState({ status: "REVOKED", expiresAt: later }, now)).toBe("REVOKED");
  });

  it("defaults to 14 days and clamps to 1 through 30", () => {
    expect(clampLinkDays(undefined)).toBe(14);
    expect(clampLinkDays(0)).toBe(1);
    expect(clampLinkDays(90)).toBe(30);
    expect(clampLinkDays(7.9)).toBe(7);
    expect(clampLinkDays(Number.NaN)).toBe(14);
  });
});

describe("resolving a session into a viewer", () => {
  const open = (role: string, actor: unknown = { kind: "ATTENDEE", accountId: "acct-1", sessionId: "s-1" }) => ({
    state: "OPEN",
    club: { organizationId: "club-a", role },
    actor,
  });

  it("makes a director or deputy a club leader, with their own account as the actor", () => {
    for (const role of ["DIRECTOR", "DEPUTY"]) {
      expect(clubLeaderViewerFromAccess(open(role) as never)).toEqual({
        kind: "CLUB_LEADER",
        organizationId: "club-a",
        actor: { kind: "ATTENDEE", accountId: "acct-1" },
      });
    }
  });

  it("turns a system administrator acting as the director into a staff actor, not an attendee", () => {
    const viewer = clubLeaderViewerFromAccess(open("DIRECTOR", { kind: "STAFF_ACTING", userId: "admin-1", actAsId: "act-1", staffSessionId: "ss-1", organizationId: "club-a" }) as never);
    expect(viewer.actor).toEqual({ kind: "STAFF_ACTING", userId: "admin-1", actAsId: "act-1" });
  });

  it("refuses a registrar and a reporter", () => {
    for (const role of ["REGISTRAR", "REPORTER"]) {
      expect(() => clubLeaderViewerFromAccess(open(role) as never)).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    }
  });

  it("passes through the roster gate's own refusal, which never reveals another club", async () => {
    mocks.requireRosterAccess.mockRejectedValue(Object.assign(new Error("That club could not be found."), { code: "NOT_FOUND", status: 404 }));
    await expect(requireClubLeaderViewer("club-b")).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("finds an Area Coordinator by their own account, or by a system administrator acting as one", async () => {
    mocks.currentAreaCoordinator.mockResolvedValue({ id: "acct-2" });
    expect(await resolveAreaCoordinatorViewer()).toEqual({ kind: "AREA_COORDINATOR", actor: { kind: "ATTENDEE", accountId: "acct-2" } });

    mocks.currentAreaCoordinator.mockResolvedValue(null);
    mocks.currentStaffActingContext.mockResolvedValue({ role: "AREA_COORDINATOR", userId: "admin-1", actAsId: "act-2" });
    expect(await resolveAreaCoordinatorViewer()).toEqual({ kind: "AREA_COORDINATOR", actor: { kind: "STAFF_ACTING", userId: "admin-1", actAsId: "act-2" } });

    // Acting as a club director is not Area Coordinator access.
    mocks.currentStaffActingContext.mockResolvedValue({ role: "CLUB_DIRECTOR", userId: "admin-1", actAsId: "act-3" });
    expect(await resolveAreaCoordinatorViewer()).toBeNull();

    mocks.currentStaffActingContext.mockResolvedValue(null);
    expect(await resolveAreaCoordinatorViewer()).toBeNull();
  });
});

describe("conference staff and VIEW_SENSITIVE_DATA (#610)", () => {
  const user = (globalRole: "SYSTEM_ADMIN" | null = null) => ({ id: "u-1", email: "staff@example.test", displayName: "Staff", globalRole });

  it("gives a system administrator everything without reading memberships", () => {
    expect(staffClubFormsAccess(user("SYSTEM_ADMIN"), [])).toEqual({ isStaff: true, canViewSensitive: true });
  });

  it("gives sensitive access to roles that hold VIEW_SENSITIVE_DATA and not to those that do not", () => {
    expect(staffClubFormsAccess(user(), [{ role: "REGISTRATION_MANAGER", permissions: [] }])).toEqual({ isStaff: true, canViewSensitive: true });
    expect(staffClubFormsAccess(user(), [{ role: "FINANCE_MANAGER", permissions: [] }]).canViewSensitive).toBe(true);
    expect(staffClubFormsAccess(user(), [{ role: "READ_ONLY_STAFF", permissions: [] }])).toEqual({ isStaff: true, canViewSensitive: false });
    expect(staffClubFormsAccess(user(), [{ role: "COMMUNICATIONS_MANAGER", permissions: [] }]).canViewSensitive).toBe(false);
  });

  it("honors an extra permission granted on the membership, on any active event", () => {
    expect(staffClubFormsAccess(user(), [
      { role: "READ_ONLY_STAFF", permissions: [] },
      { role: "READ_ONLY_STAFF", permissions: ["VIEW_SENSITIVE_DATA"] },
    ]).canViewSensitive).toBe(true);
  });

  it("is not staff without an active membership", () => {
    expect(staffClubFormsAccess(user(), [])).toEqual({ isStaff: false, canViewSensitive: false });
  });

  it("resolves a signed-in staff member, and nobody when signed out or not staff", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: user() });
    mocks.membershipFindMany.mockResolvedValue([{ role: "REGISTRATION_MANAGER", permissions: [] }]);
    expect(await resolveStaffViewer()).toEqual({ kind: "STAFF", userId: "u-1", canViewSensitive: true });
    expect(mocks.membershipFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "u-1", status: "ACTIVE" } }));

    mocks.membershipFindMany.mockResolvedValue([]);
    expect(await resolveStaffViewer()).toBeNull();

    mocks.getCurrentSession.mockResolvedValue({ user: null });
    expect(await resolveStaffViewer()).toBeNull();
  });

  it("refuses staff routes with 401 when signed out and 403 when not staff", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: null });
    await expect(requireStaffViewer()).rejects.toMatchObject({ status: 401 });
    mocks.getCurrentSession.mockResolvedValue({ user: user() });
    mocks.membershipFindMany.mockResolvedValue([]);
    await expect(requireStaffViewer()).rejects.toMatchObject({ status: 403 });
  });
});
