import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A club's driver verification queue (#491) sits behind the roster's own
 * gate (`requireRosterAccess`): the person's own session, an authenticator
 * set up, and a recent second step — not just a club role. Only the lowest
 * layers (session, club list, database) are faked here, so the real gate runs.
 */

const mocks = vi.hoisted(() => ({
  getCurrentAttendee: vi.fn(),
  listDirectedClubs: vi.fn(),
  findEnrollment: vi.fn(),
  findSession: vi.fn(),
  countPasskeys: vi.fn(),
  findSettings: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  listWillingDrivers: vi.fn(),
  recordDriverClearance: vi.fn(),
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
  return { ...actual, listWillingDrivers: mocks.listWillingDrivers, recordDriverClearance: mocks.recordDriverClearance };
});

import { ROSTER_UNLOCK_HOURS } from "@/modules/club-rosters/access";
import { GET as clubList } from "@/app/api/attendee/clubs/[organizationId]/driver-verification/route";
import { POST as clubClear } from "@/app/api/attendee/clubs/[organizationId]/driver-verification/[personId]/route";

const account = { id: "director-1", verifiedEmail: "director@example.test", displayName: "Test Director" };
const directedClub = (role: string) => ({ organizationId: "club-1", name: "Test Pathfinders", role, sponsoringChurch: null });

const listRequest = (organizationId = "club-1") =>
  new Request(`https://events.imsda.test/api/attendee/clubs/${organizationId}/driver-verification`);
const listContext = (organizationId = "club-1") => ({ params: Promise.resolve({ organizationId }) });
const clearRequest = (organizationId = "club-1") => new Request(
  `https://events.imsda.test/api/attendee/clubs/${organizationId}/driver-verification/person-1`,
  {
    method: "POST",
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: JSON.stringify({ clearedToTransport: true, note: "Checked.", confirmedChecksReviewed: true }),
  },
);
const clearContext = (organizationId = "club-1") => ({ params: Promise.resolve({ organizationId, personId: "person-1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentAttendee.mockResolvedValue({ account, via: "attendee", sessionId: "session-1" });
  mocks.listDirectedClubs.mockResolvedValue([directedClub("DIRECTOR")]);
  mocks.findEnrollment.mockResolvedValue({ status: "ACTIVE" });
  mocks.findSession.mockResolvedValue({ secondFactorVerifiedAt: new Date(Date.now() - 60_000) });
  mocks.countPasskeys.mockResolvedValue(0);
  mocks.findSettings.mockResolvedValue({ passkeyRpId: null });
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.listWillingDrivers.mockResolvedValue([]);
  mocks.recordDriverClearance.mockResolvedValue(undefined);
});

describe("the club driver verification queue uses the roster's gate (#491)", () => {
  it("opens for a director with a recent second step, scoped to their club", async () => {
    const response = await clubList(listRequest(), listContext());
    expect(response.status).toBe(200);
    expect(mocks.listWillingDrivers).toHaveBeenCalledWith({ kind: "CLUB", organizationId: "club-1" });
  });

  it("needs the second step again once the roster unlock window has passed", async () => {
    mocks.findSession.mockResolvedValue({
      secondFactorVerifiedAt: new Date(Date.now() - (ROSTER_UNLOCK_HOURS * 3_600_000 + 60_000)),
    });
    const list = await clubList(listRequest(), listContext());
    expect(list.status).toBe(403);
    await expect(list.json()).resolves.toMatchObject({ error: "MFA_UNLOCK_REQUIRED" });
    const clear = await clubClear(clearRequest(), clearContext());
    expect(clear.status).toBe(403);
    await expect(clear.json()).resolves.toMatchObject({ error: "MFA_UNLOCK_REQUIRED" });
    expect(mocks.listWillingDrivers).not.toHaveBeenCalled();
    expect(mocks.recordDriverClearance).not.toHaveBeenCalled();
  });

  it("needs an authenticator or passkey set up at all", async () => {
    mocks.findEnrollment.mockResolvedValue(null);
    const response = await clubList(listRequest(), listContext());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "MFA_SETUP_REQUIRED" });
    expect(mocks.listWillingDrivers).not.toHaveBeenCalled();
  });

  it("answers 404 for another club, never hinting it exists", async () => {
    const list = await clubList(listRequest("club-2"), listContext("club-2"));
    expect(list.status).toBe(404);
    await expect(list.json()).resolves.toMatchObject({ error: "NOT_FOUND" });
    const clear = await clubClear(clearRequest("club-2"), clearContext("club-2"));
    expect(clear.status).toBe(404);
    expect(mocks.listWillingDrivers).not.toHaveBeenCalled();
    expect(mocks.recordDriverClearance).not.toHaveBeenCalled();
  });

  it("refuses a registrar, who reaches the roster but doesn't manage the team", async () => {
    mocks.listDirectedClubs.mockResolvedValue([directedClub("REGISTRAR")]);
    const response = await clubList(listRequest(), listContext());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "ROLE_NOT_ALLOWED" });
  });
});
