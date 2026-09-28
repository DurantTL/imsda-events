import { existsSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A club's driver list (#544) sits behind the roster's own gate
 * (`requireRosterAccess`): the person's own session, an authenticator set up,
 * and a recent second step — not just a club role. Only the lowest layers
 * (session, club list, database) are faked here, so the real gate runs.
 */

const mocks = vi.hoisted(() => ({
  getCurrentAttendee: vi.fn(),
  listDirectedClubs: vi.fn(),
  findEnrollment: vi.fn(),
  findSession: vi.fn(),
  countPasskeys: vi.fn(),
  findSettings: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  clubDriverEntries: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/attendee-accounts/sign-in-gate", () => ({ accountNeedsSecondStep: async () => "OK" }));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    attendeeMfaEnrollment: { findUnique: mocks.findEnrollment },
    attendeeSession: { findUnique: mocks.findSession },
    attendeePasskey: { count: mocks.countPasskeys },
    platformSettings: { findUnique: mocks.findSettings },
  }),
}));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: mocks.listDirectedClubs }));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: async () => null }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/driver-verification/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/driver-verification/repository")>("@/modules/driver-verification/repository");
  return { ...actual, clubDriverEntries: mocks.clubDriverEntries };
});

import { ROSTER_UNLOCK_HOURS } from "@/modules/club-rosters/access";
import { GET as clubList } from "@/app/api/attendee/clubs/[organizationId]/driver-verification/route";

const account = { id: "director-1", verifiedEmail: "director@example.test", displayName: "Test Director" };
const directedClub = (role: string) => ({ organizationId: "club-1", name: "Test Pathfinders", role, sponsoringChurch: null });

const listRequest = (organizationId = "club-1") =>
  new Request(`https://events.imsda.test/api/attendee/clubs/${organizationId}/driver-verification`);
const listContext = (organizationId = "club-1") => ({ params: Promise.resolve({ organizationId }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentAttendee.mockResolvedValue({ account, via: "attendee", sessionId: "session-1" });
  mocks.listDirectedClubs.mockResolvedValue([directedClub("DIRECTOR")]);
  mocks.findEnrollment.mockResolvedValue({ status: "ACTIVE" });
  mocks.findSession.mockResolvedValue({ secondFactorVerifiedAt: new Date(Date.now() - 60_000) });
  mocks.countPasskeys.mockResolvedValue(0);
  mocks.findSettings.mockResolvedValue({ passkeyRpId: null });
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.clubDriverEntries.mockResolvedValue([]);
});

describe("the club driver list uses the roster's gate (#544)", () => {
  it("opens for a director with a recent second step, scoped to their club", async () => {
    const response = await clubList(listRequest(), listContext());
    expect(response.status).toBe(200);
    expect(mocks.clubDriverEntries).toHaveBeenCalledWith("club-1", expect.stringMatching(/^\d{4}-\d{2}$/));
  });

  it("needs the second step again once the roster unlock window has passed", async () => {
    mocks.findSession.mockResolvedValue({
      secondFactorVerifiedAt: new Date(Date.now() - (ROSTER_UNLOCK_HOURS * 3_600_000 + 60_000)),
    });
    const list = await clubList(listRequest(), listContext());
    expect(list.status).toBe(403);
    await expect(list.json()).resolves.toMatchObject({ error: "MFA_UNLOCK_REQUIRED" });
    expect(mocks.clubDriverEntries).not.toHaveBeenCalled();
  });

  it("needs an authenticator or passkey set up at all", async () => {
    mocks.findEnrollment.mockResolvedValue(null);
    const response = await clubList(listRequest(), listContext());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "MFA_SETUP_REQUIRED" });
    expect(mocks.clubDriverEntries).not.toHaveBeenCalled();
  });

  it("answers 404 for another club, never hinting it exists", async () => {
    const list = await clubList(listRequest("club-2"), listContext("club-2"));
    expect(list.status).toBe(404);
    await expect(list.json()).resolves.toMatchObject({ error: "NOT_FOUND" });
    expect(mocks.clubDriverEntries).not.toHaveBeenCalled();
  });

  it("refuses a registrar, who reaches the roster but doesn't manage the team", async () => {
    mocks.listDirectedClubs.mockResolvedValue([directedClub("REGISTRAR")]);
    const response = await clubList(listRequest(), listContext());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "ROLE_NOT_ALLOWED" });
  });

  it("returns exactly what the repository gives, which is labels only", async () => {
    const entries = [{ rosterMemberId: "member-1", firstName: "Dana", lastName: "Driver", attendeeType: "STAFF", status: "NOT_CLEARED", label: "Not cleared" }];
    mocks.clubDriverEntries.mockResolvedValue(entries);
    const response = await clubList(listRequest(), listContext());
    await expect(response.json()).resolves.toEqual({ entries });
  });

  it("has no route for a club to override clearance", () => {
    const dir = path.join(process.cwd(), "app/api/attendee/clubs/[organizationId]/driver-verification");
    expect(existsSync(path.join(dir, "[personId]"))).toBe(false);
  });
});
