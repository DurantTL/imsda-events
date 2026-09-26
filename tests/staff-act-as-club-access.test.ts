import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentStaffActingContext: vi.fn(),
  getCurrentAttendee: vi.fn(),
  listDirectedClubs: vi.fn(),
  findOrganization: vi.fn(),
  findEnrollment: vi.fn(),
  findSession: vi.fn(),
  countPasskeys: vi.fn(),
  findSettings: vi.fn(),
}));

const client = {
  organization: { findUnique: mocks.findOrganization },
  attendeeMfaEnrollment: { findUnique: mocks.findEnrollment },
  attendeeSession: { findUnique: mocks.findSession },
  attendeePasskey: { count: mocks.countPasskeys },
  platformSettings: { findUnique: mocks.findSettings },
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/attendee-accounts/passkeys", () => ({ passkeysConfigured: async () => false }));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: mocks.listDirectedClubs }));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: mocks.currentStaffActingContext }));

import { getClubRoleAccess, getRosterAccessState, requireRosterAccess } from "@/modules/club-rosters/access";

const clubA = { id: "club-a", type: "CLUB", isActive: true, name: "Club A", parentOrganization: null };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentStaffActingContext.mockResolvedValue(null);
  mocks.getCurrentAttendee.mockResolvedValue({ account: null, via: null, sessionId: null });
  mocks.listDirectedClubs.mockResolvedValue([]);
  mocks.findOrganization.mockResolvedValue(clubA);
});

describe("club access while a staff member is acting as director (#442)", () => {
  it("opens the exact club the act-as names, with full director capabilities, no attendee account or MFA gate", async () => {
    mocks.currentStaffActingContext.mockResolvedValue({
      userId: "admin-1", staffSessionId: "staff-session-1", actAsId: "act-1",
      role: "CLUB_DIRECTOR", organizationId: "club-a", expiresAt: new Date("2026-09-26T14:00:00Z"),
    });
    const access = await getRosterAccessState("club-a");
    expect(access).toMatchObject({
      state: "OPEN",
      capabilities: { roster: true, manageTeam: true, seeBirthDates: true, editProfile: true, submitReports: true },
      actor: { kind: "STAFF_ACTING", userId: "admin-1", staffSessionId: "staff-session-1", actAsId: "act-1", organizationId: "club-a" },
    });
    // getCurrentAttendee is never consulted for this club: the act-as decides on its own.
    expect(mocks.getCurrentAttendee).not.toHaveBeenCalled();
  });

  it("never grants another club: acting as director of club A gets nothing for club B", async () => {
    mocks.currentStaffActingContext.mockResolvedValue({
      userId: "admin-1", staffSessionId: "staff-session-1", actAsId: "act-1",
      role: "CLUB_DIRECTOR", organizationId: "club-a", expiresAt: new Date("2026-09-26T14:00:00Z"),
    });
    // No attendee account and no act-as for club-b: falls through to the ordinary attendee path, which signs out.
    await expect(getRosterAccessState("club-b")).resolves.toEqual({ state: "SIGN_IN" });
    await expect(requireRosterAccess("club-b")).rejects.toMatchObject({ code: "SIGN_IN_REQUIRED", status: 401 });
  });

  it("grants no club access at all while acting as an Area Coordinator", async () => {
    mocks.currentStaffActingContext.mockResolvedValue({
      userId: "admin-1", staffSessionId: "staff-session-1", actAsId: "act-2",
      role: "AREA_COORDINATOR", organizationId: null, expiresAt: new Date("2026-09-26T14:00:00Z"),
    });
    await expect(getRosterAccessState("club-a")).resolves.toEqual({ state: "SIGN_IN" });
    await expect(getClubRoleAccess("club-a")).resolves.toEqual({ state: "SIGN_IN" });
  });

  it("is NOT_FOUND once the club the act-as names is gone or inactive", async () => {
    mocks.currentStaffActingContext.mockResolvedValue({
      userId: "admin-1", staffSessionId: "staff-session-1", actAsId: "act-1",
      role: "CLUB_DIRECTOR", organizationId: "club-a", expiresAt: new Date("2026-09-26T14:00:00Z"),
    });
    mocks.findOrganization.mockResolvedValue({ ...clubA, isActive: false });
    await expect(getRosterAccessState("club-a")).resolves.toEqual({ state: "NOT_FOUND" });
  });

  it("leaves a real attendee director's own access unchanged when nobody is acting", async () => {
    mocks.currentStaffActingContext.mockResolvedValue(null);
    mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "account-1", verifiedEmail: "d@example.test", displayName: "Director" }, via: "attendee", sessionId: "session-1" });
    mocks.listDirectedClubs.mockResolvedValue([{ organizationId: "club-a", name: "Club A", role: "DIRECTOR", sponsoringChurch: null }]);
    mocks.findEnrollment.mockResolvedValue({ status: "ACTIVE" });
    mocks.findSession.mockResolvedValue({ secondFactorVerifiedAt: new Date() });
    const access = await getRosterAccessState("club-a");
    expect(access).toMatchObject({ state: "OPEN", actor: { kind: "ATTENDEE", accountId: "account-1", sessionId: "session-1" } });
  });
});
