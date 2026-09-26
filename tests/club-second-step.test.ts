import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The attendee sign-in second step (decision 2026-09-23) enforced at the club
 * access choke point, not only in the portal layout (#442 follow-up): pages,
 * API routes, reporters included. Runs the real sign-in gate, the real club
 * access module, the real portal-second-step helper, and the real routes and
 * pages; only the sessions and the database are stubbed.
 */
const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  getCurrentAttendee: vi.fn(),
  listDirectedClubs: vi.fn(),
  redirect: vi.fn((to: string) => { throw new Error(`REDIRECT ${to}`); }),
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
  attendeeSessionFindUnique: vi.fn(),
  actAsFindFirst: vi.fn(),
  noteCreate: vi.fn(),
  reportFindUnique: vi.fn(),
}));

const client = {
  staffActAs: { findFirst: mocks.actAsFindFirst, updateMany: vi.fn() },
  userSession: {
    findUnique: async () => ({
      expiresAt: new Date(Date.now() + 6 * 3_600_000), revokedAt: null, lastSeenAt: new Date(),
      user: { id: "admin-1", globalRole: "SYSTEM_ADMIN", accountStatus: "ACTIVE", credential: { disabledAt: null } },
    }),
  },
  organization: {
    findUnique: async ({ where }: { where: { id: string } }) => (
      where.id === "club-a" || where.id === "club-b"
        ? { type: "CLUB", isActive: true, name: where.id === "club-a" ? "Club A" : "Club B", parentOrganization: null }
        : null
    ),
  },
  areaCoordinatorGrant: { findUnique: async () => null },
  attendeeSession: { findUnique: mocks.attendeeSessionFindUnique },
  attendeeMfaEnrollment: { findUnique: async () => ({ status: "ACTIVE" }) },
  attendeePasskey: { count: async () => 0 },
  clubMeetingNote: { create: mocks.noteCreate },
  clubMonthlyReport: { findUnique: mocks.reportFindUnique },
  $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, notFound: mocks.notFound }));
vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({ APP_BASE_URL: "https://events.imsda.test", SECRET_ENCRYPTION_KEY: "a-secret-encryption-key-of-adequate-length" }),
  isServerEnvironmentError: () => false,
}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/attendee-accounts/passkeys", () => ({ passkeysConfigured: async () => false, getPasskeySettings: vi.fn() }));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: mocks.listDirectedClubs }));

import { PUT as SAVE_REPORT } from "@/app/api/attendee/clubs/[organizationId]/reports/[month]/route";
import { POST as ADD_NOTE } from "@/app/api/attendee/clubs/[organizationId]/notes/route";
import ClubLayout from "@/app/(public)/account/(portal)/clubs/[organizationId]/layout";
import OverviewPage from "@/app/(public)/account/(portal)/page";
import ProfilePage from "@/app/(public)/account/(portal)/profile/page";
import RegistrationsPage from "@/app/(public)/account/(portal)/registrations/page";
import SecurityPage from "@/app/(public)/account/(portal)/security/page";
import { attendeeSecondStepPending, requireAttendeeSecondStep } from "@/modules/attendee-accounts/portal-second-step";
import {
  getClubRoleAccess,
  getClubRoleAccessForPage,
  getRosterAccessState,
  getRosterAccessStateForPage,
  requireClubCapability,
  requireRosterAccess,
} from "@/modules/club-rosters/access";

const attendee = { account: { id: "account-b", verifiedEmail: "director.b@example.test", displayName: "Director B" }, via: "attendee", sessionId: "attendee-session-b" };
const clubB = (role: string) => [{ organizationId: "club-b", name: "Club B", role, sponsoringChurch: null }];
const pending = () => mocks.attendeeSessionFindUnique.mockResolvedValue({ secondFactorVerifiedAt: null });
const passed = (at = new Date(Date.now() - 60_000)) => mocks.attendeeSessionFindUnique.mockResolvedValue({ secondFactorVerifiedAt: at });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentSession.mockResolvedValue({ user: null });
  mocks.actAsFindFirst.mockResolvedValue(null);
  mocks.getCurrentAttendee.mockResolvedValue(attendee);
  mocks.listDirectedClubs.mockImplementation(async (accountId: string) => (accountId === "account-b" ? clubB("DIRECTOR") : []));
  pending();
});

describe("club access helpers with a pending second step", () => {
  it("return SECOND_STEP_REQUIRED for a director, and the require* helpers throw 403", async () => {
    await expect(getRosterAccessState("club-b")).resolves.toMatchObject({ state: "SECOND_STEP_REQUIRED", club: { organizationId: "club-b" } });
    await expect(getClubRoleAccess("club-b")).resolves.toMatchObject({ state: "SECOND_STEP_REQUIRED" });
    await expect(requireRosterAccess("club-b")).rejects.toMatchObject({ code: "SECOND_STEP_REQUIRED", status: 403, message: "Finish two-step sign-in to open your club." });
    await expect(requireClubCapability("club-b", "submitReports")).rejects.toMatchObject({ code: "SECOND_STEP_REQUIRED", status: 403 });
  });

  it("cover a reporter, who never reaches the roster's own check", async () => {
    mocks.listDirectedClubs.mockResolvedValue(clubB("REPORTER"));
    await expect(getRosterAccessState("club-b")).resolves.toMatchObject({ state: "SECOND_STEP_REQUIRED" });
    await expect(requireClubCapability("club-b", "submitReports")).rejects.toMatchObject({ code: "SECOND_STEP_REQUIRED" });
  });

  it("still hide other clubs as NOT_FOUND rather than revealing them", async () => {
    await expect(getClubRoleAccess("club-a")).resolves.toEqual({ state: "NOT_FOUND" });
  });

  it("open once the second step is passed; the same pass also unlocks the roster", async () => {
    passed();
    await expect(getRosterAccessState("club-b")).resolves.toMatchObject({ state: "OPEN", actor: { kind: "ATTENDEE", accountId: "account-b" } });
    await expect(getClubRoleAccess("club-b")).resolves.toMatchObject({ state: "OK" });
  });

  it("keep the roster's 12-hour re-unlock for a second step passed long ago", async () => {
    passed(new Date(Date.now() - 13 * 3_600_000));
    await expect(getRosterAccessState("club-b")).resolves.toMatchObject({ state: "MFA_UNLOCK" });
    // Monthly reports don't need the roster's re-unlock.
    await expect(getClubRoleAccess("club-b")).resolves.toMatchObject({ state: "OK" });
  });

  it("the page variants send a pending second step to /account/two-step", async () => {
    await expect(getRosterAccessStateForPage("club-b")).rejects.toThrow("REDIRECT /account/two-step");
    await expect(getClubRoleAccessForPage("club-b")).rejects.toThrow("REDIRECT /account/two-step");
  });

  it("never apply to a staff act-as for its own club", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "admin-1", email: "admin@example.test", displayName: "Admin", globalRole: "SYSTEM_ADMIN" }, sessionId: "staff-session-1" });
    mocks.actAsFindFirst.mockResolvedValue({ id: "act-1", userId: "admin-1", staffSessionId: "staff-session-1", role: "CLUB_DIRECTOR", organizationId: "club-a", expiresAt: new Date(Date.now() + 3_600_000) });
    await expect(getRosterAccessState("club-a")).resolves.toMatchObject({ state: "OPEN", actor: { kind: "STAFF_ACTING" } });
  });
});

describe("club API routes with a pending second step", () => {
  const request = (method: string, url: string, body: unknown) => new Request(url, {
    method,
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  it("refuse a monthly report save with 403 SECOND_STEP_REQUIRED", async () => {
    const response = await SAVE_REPORT(
      request("PUT", "https://events.imsda.test/api/attendee/clubs/club-b/reports/2026-09", { points: { staffMeeting: 25 }, signatureName: "Pat Example", signedOn: "2026-10-05", status: "SUBMITTED" }),
      { params: Promise.resolve({ organizationId: "club-b", month: "2026-09" }) },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "SECOND_STEP_REQUIRED" });
    expect(mocks.reportFindUnique).not.toHaveBeenCalled();
  });

  it("refuse a new meeting note with 403 SECOND_STEP_REQUIRED, for a reporter too", async () => {
    mocks.listDirectedClubs.mockResolvedValue(clubB("REPORTER"));
    const response = await ADD_NOTE(
      request("POST", "https://events.imsda.test/api/attendee/clubs/club-b/notes", { meetingDate: "2026-09-20", notes: "Test" }),
      { params: Promise.resolve({ organizationId: "club-b" }) },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "SECOND_STEP_REQUIRED" });
    expect(mocks.noteCreate).not.toHaveBeenCalled();
  });
});

describe("account pages with a pending second step and no act-as", () => {
  it.each([
    ["Overview", () => OverviewPage()],
    ["Profile", () => ProfilePage()],
    ["Registrations", () => RegistrationsPage()],
    ["Security", () => SecurityPage()],
  ])("%s redirects to /account/two-step", async (_name, render) => {
    await expect(render()).rejects.toThrow("REDIRECT /account/two-step");
  });
});

describe("the club layout while acting as club A's director", () => {
  beforeEach(() => {
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "admin-1", email: "admin@example.test", displayName: "Admin", globalRole: "SYSTEM_ADMIN" }, sessionId: "staff-session-1" });
    mocks.actAsFindFirst.mockResolvedValue({ id: "act-1", userId: "admin-1", staffSessionId: "staff-session-1", role: "CLUB_DIRECTOR", organizationId: "club-a", expiresAt: new Date(Date.now() + 3_600_000) });
  });
  const layout = (organizationId: string) => ClubLayout({ children: null, params: Promise.resolve({ organizationId }) });

  it("opens club A from the staff session, ignoring the pending attendee cookie", async () => {
    await expect(layout("club-a")).resolves.toBeTruthy();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("still sends club B (the attendee cookie's club) to /account/two-step", async () => {
    await expect(layout("club-b")).rejects.toThrow("REDIRECT /account/two-step");
  });
});

describe("portal-second-step", () => {
  it("is pending only for this browser's own attendee session that hasn't passed the step", async () => {
    await expect(attendeeSecondStepPending()).resolves.toBe(true);
    passed();
    await expect(attendeeSecondStepPending()).resolves.toBe(false);
    pending();
    mocks.getCurrentAttendee.mockResolvedValueOnce({ ...attendee, via: "staff", sessionId: null });
    await expect(attendeeSecondStepPending()).resolves.toBe(false);
    mocks.getCurrentAttendee.mockResolvedValueOnce({ account: null, via: null, sessionId: null });
    await expect(attendeeSecondStepPending()).resolves.toBe(false);
    // An ordinary attendee with no club role never needs it.
    mocks.listDirectedClubs.mockResolvedValueOnce([]);
    await expect(attendeeSecondStepPending()).resolves.toBe(false);
  });

  it("requireAttendeeSecondStep redirects only when pending", async () => {
    await expect(requireAttendeeSecondStep()).rejects.toThrow("REDIRECT /account/two-step");
    passed();
    await expect(requireAttendeeSecondStep()).resolves.toBeUndefined();
  });
});
