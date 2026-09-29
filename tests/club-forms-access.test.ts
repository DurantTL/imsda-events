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
  restrictedFieldKeys,
  viewerCanRevealBirthDates,
  viewerCanRevealSensitive,
  viewerCanSeeClub,
  viewerCanWriteForClub,
  viewerSeesDrafts,
  type ClubFormsViewer,
} from "@/modules/club-forms/domain";

const director: ClubFormsViewer = { kind: "CLUB_LEADER", organizationId: "club-a", actor: { kind: "ATTENDEE", accountId: "acct-1" } };
const actingDirector: ClubFormsViewer = { kind: "CLUB_LEADER", organizationId: "club-a", actor: { kind: "STAFF_ACTING", userId: "admin-1", actAsId: "act-1" } };
const areaCoordinator: ClubFormsViewer = { kind: "AREA_COORDINATOR", actor: { kind: "ATTENDEE", accountId: "acct-2" } };
const systemAdminStaff: ClubFormsViewer = { kind: "STAFF", userId: "staff-1", systemAdmin: true };
const eventAdminStaff: ClubFormsViewer = { kind: "STAFF", userId: "staff-2", systemAdmin: false };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("club forms role matrix (#610)", () => {
  it("lets only the club's own director or deputy write", () => {
    expect(viewerCanWriteForClub(director, "club-a")).toBe(true);
    expect(viewerCanWriteForClub(actingDirector, "club-a")).toBe(true);
    expect(viewerCanWriteForClub(director, "club-b")).toBe(false);
    for (const viewer of [areaCoordinator, systemAdminStaff, eventAdminStaff]) {
      expect(viewerCanWriteForClub(viewer, "club-a")).toBe(false);
    }
  });

  it("keeps a club's director to their own club", () => {
    expect(viewerCanSeeClub(director, "club-a")).toBe(true);
    expect(viewerCanSeeClub(director, "club-b")).toBe(false);
    for (const viewer of [areaCoordinator, systemAdminStaff, eventAdminStaff]) expect(viewerCanSeeClub(viewer, "club-b")).toBe(true);
  });

  it("shows health, conduct and emergency answers to the club's leaders and conference staff, never to an Area Coordinator", () => {
    expect(viewerCanRevealSensitive(director, "club-a")).toBe(true);
    expect(viewerCanRevealSensitive(director, "club-b")).toBe(false);
    expect(viewerCanRevealSensitive(actingDirector, "club-a")).toBe(true);
    expect(viewerCanRevealSensitive(systemAdminStaff, "club-b")).toBe(true);
    expect(viewerCanRevealSensitive(eventAdminStaff, "club-b")).toBe(true);
    expect(viewerCanRevealSensitive(areaCoordinator, "club-a")).toBe(false);
  });

  it("shows full birth dates only to the club's own leaders and system administrators (ADR 0005 Addendum A)", () => {
    expect(viewerCanRevealBirthDates(director, "club-a")).toBe(true);
    expect(viewerCanRevealBirthDates(director, "club-b")).toBe(false);
    expect(viewerCanRevealBirthDates(actingDirector, "club-a")).toBe(true);
    expect(viewerCanRevealBirthDates(systemAdminStaff, "club-b")).toBe(true);
    expect(viewerCanRevealBirthDates(eventAdminStaff, "club-b")).toBe(false);
    expect(viewerCanRevealBirthDates(areaCoordinator, "club-a")).toBe(false);
  });

  it("lists the fields each viewer sees as Restricted, birth dates separately from the other sensitive answers", () => {
    const template = { sensitiveFieldKeys: ["birth_date", "health_limitation", "child_1_birth_date"], birthDateFieldKeys: ["birth_date", "child_1_birth_date"] };
    expect(restrictedFieldKeys(director, "club-a", template)).toEqual([]);
    expect(restrictedFieldKeys(systemAdminStaff, "club-a", template)).toEqual([]);
    expect(restrictedFieldKeys(eventAdminStaff, "club-a", template)).toEqual(["birth_date", "child_1_birth_date"]);
    expect(restrictedFieldKeys(areaCoordinator, "club-a", template)).toEqual(["birth_date", "health_limitation", "child_1_birth_date"]);
    expect(restrictedFieldKeys(director, "club-b", template)).toEqual(["birth_date", "health_limitation", "child_1_birth_date"]);
  });

  it("shows drafts to the club only", () => {
    expect(viewerSeesDrafts(director)).toBe(true);
    expect(viewerSeesDrafts(areaCoordinator)).toBe(false);
    expect(viewerSeesDrafts(systemAdminStaff)).toBe(false);
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
    expect(viewerAuditFields(eventAdminStaff)).toEqual({ actorUserId: "staff-2", metadata: { viewerKind: "STAFF" } });
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

describe("conference staff: system administrators and Event Admins of a current event (#610)", () => {
  const user = (globalRole: "SYSTEM_ADMIN" | null = null) => ({ id: "u-1", email: "staff@example.test", displayName: "Staff", globalRole });
  const now = new Date("2026-10-05T15:00:00Z");
  const currentEvent = { timezone: "America/Chicago", endsAt: new Date("2026-10-10T20:00:00Z") };
  const endedEvent = { timezone: "America/Chicago", endsAt: new Date("2026-10-01T20:00:00Z") };
  const roles = ["CHECK_IN_STAFF", "READ_ONLY_STAFF", "COMMUNICATIONS_MANAGER", "REGISTRATION_MANAGER", "FINANCE_MANAGER"];

  it("gives a system administrator access, including birth dates, without reading memberships", () => {
    expect(staffClubFormsAccess(user("SYSTEM_ADMIN"), [], now)).toEqual({ isStaff: true, systemAdmin: true });
  });

  it("gives an Event Admin of a current event access, without birth dates", () => {
    expect(staffClubFormsAccess(user(), [{ role: "EVENT_ADMIN", event: currentEvent }], now)).toEqual({ isStaff: true, systemAdmin: false });
  });

  it("counts an event through its last calendar day", () => {
    const lastDay = { timezone: "America/Chicago", endsAt: new Date("2026-10-05T23:00:00Z") };
    expect(staffClubFormsAccess(user(), [{ role: "EVENT_ADMIN", event: lastDay }], now).isStaff).toBe(true);
    expect(staffClubFormsAccess(user(), [{ role: "EVENT_ADMIN", event: lastDay }], new Date("2026-10-06T15:00:00Z")).isStaff).toBe(false);
  });

  it("gives an Event Admin of an ended event nothing", () => {
    expect(staffClubFormsAccess(user(), [{ role: "EVENT_ADMIN", event: endedEvent }], now)).toEqual({ isStaff: false, systemAdmin: false });
  });

  it("uses any current event when the person administers several", () => {
    expect(staffClubFormsAccess(user(), [{ role: "EVENT_ADMIN", event: endedEvent }, { role: "EVENT_ADMIN", event: currentEvent }], now).isStaff).toBe(true);
  });

  it.each(roles)("gives %s nothing, even on a current event", (role) => {
    expect(staffClubFormsAccess(user(), [{ role, event: currentEvent }], now)).toEqual({ isStaff: false, systemAdmin: false });
  });

  it("gives nothing without an active membership", () => {
    expect(staffClubFormsAccess(user(), [], now)).toEqual({ isStaff: false, systemAdmin: false });
  });

  it("asks only for active Event Admin memberships, and resolves a current Event Admin", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: user() });
    mocks.membershipFindMany.mockResolvedValue([{ role: "EVENT_ADMIN", event: currentEvent }]);
    expect(await resolveStaffViewer(now)).toEqual({ kind: "STAFF", userId: "u-1", systemAdmin: false });
    expect(mocks.membershipFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "u-1", status: "ACTIVE", role: "EVENT_ADMIN" } }));
  });

  it("resolves a system administrator without a membership query", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: user("SYSTEM_ADMIN") });
    expect(await resolveStaffViewer(now)).toEqual({ kind: "STAFF", userId: "u-1", systemAdmin: true });
    expect(mocks.membershipFindMany).not.toHaveBeenCalled();
  });

  it("resolves nobody for an Event Admin of an ended event, or when signed out", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: user() });
    mocks.membershipFindMany.mockResolvedValue([{ role: "EVENT_ADMIN", event: endedEvent }]);
    expect(await resolveStaffViewer(now)).toBeNull();
    mocks.membershipFindMany.mockResolvedValue([]);
    expect(await resolveStaffViewer(now)).toBeNull();
    mocks.getCurrentSession.mockResolvedValue({ user: null });
    expect(await resolveStaffViewer(now)).toBeNull();
  });

  it("refuses staff routes with 401 when signed out and 403 when not staff", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: null });
    await expect(requireStaffViewer()).rejects.toMatchObject({ status: 401 });
    mocks.getCurrentSession.mockResolvedValue({ user: user() });
    mocks.membershipFindMany.mockResolvedValue([]);
    await expect(requireStaffViewer()).rejects.toMatchObject({ status: 403 });
  });
});
