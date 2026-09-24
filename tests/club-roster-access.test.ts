import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentAttendee: vi.fn(),
  listDirectedClubs: vi.fn(),
  findEnrollment: vi.fn(),
  findSession: vi.fn(),
  countPasskeys: vi.fn(),
  findSettings: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  verifyAttendeeSecondFactor: vi.fn(),
  updateSession: vi.fn(),
  checkRateLimit: vi.fn(),
  listRoster: vi.fn(),
  addRosterMember: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    attendeeMfaEnrollment: { findUnique: mocks.findEnrollment },
    attendeeSession: { findUnique: mocks.findSession, update: mocks.updateSession },
    attendeePasskey: { count: mocks.countPasskeys },
    platformSettings: { findUnique: mocks.findSettings },
  }),
}));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: mocks.listDirectedClubs }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/attendee-accounts/mfa-service", async () => {
  const actual = await vi.importActual<typeof import("@/modules/attendee-accounts/mfa-service")>("@/modules/attendee-accounts/mfa-service");
  return { ...actual, verifyAttendeeSecondFactor: mocks.verifyAttendeeSecondFactor };
});
vi.mock("@/modules/rate-limit/service", () => ({ checkAttendeeRosterUnlockRateLimit: mocks.checkRateLimit }));
vi.mock("@/modules/club-rosters/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-rosters/repository")>("@/modules/club-rosters/repository");
  return { ...actual, listRoster: mocks.listRoster, addRosterMember: mocks.addRosterMember };
});

import { GET, POST } from "@/app/api/attendee/clubs/[organizationId]/roster/route";
import { POST as UNLOCK } from "@/app/api/attendee/roster-unlock/route";
import { AttendeeMfaError } from "@/modules/attendee-accounts/mfa-service";
import { getRosterAccessState, ROSTER_UNLOCK_HOURS } from "@/modules/club-rosters/access";

const now = new Date("2026-10-01T15:00:00Z");
const club = { organizationId: "club-1", name: "Test Pathfinders", role: "DIRECTOR", sponsoringChurch: null };
const account = { id: "director-1", verifiedEmail: "director@example.test", displayName: "Test Director" };
const clubContext = (organizationId = "club-1") => ({ params: Promise.resolve({ organizationId }) });

function request(body?: unknown) {
  return new Request("https://events.imsda.test/api/attendee/x", {
    method: body === undefined ? "GET" : "POST",
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentAttendee.mockResolvedValue({ account, via: "attendee", sessionId: "session-1" });
  mocks.listDirectedClubs.mockResolvedValue([club]);
  mocks.findEnrollment.mockResolvedValue({ status: "ACTIVE" });
  mocks.findSession.mockResolvedValue({ secondFactorVerifiedAt: new Date(Date.now() - 60_000) });
  mocks.countPasskeys.mockResolvedValue(0);
  mocks.findSettings.mockResolvedValue({ passkeyRpId: null });
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.checkRateLimit.mockResolvedValue({ allowed: true, decisions: [] });
  mocks.listRoster.mockResolvedValue([]);
  mocks.addRosterMember.mockResolvedValue("member-1");
});

describe("who may open a roster", () => {
  it("opens only for a current director with an unlocked session", async () => {
    mocks.findSession.mockResolvedValue({ secondFactorVerifiedAt: new Date(now.getTime() - 60_000) });
    await expect(getRosterAccessState("club-1", now)).resolves.toMatchObject({ state: "OPEN", accountId: "director-1" });
  });

  it("hides clubs the person doesn't direct", async () => {
    await expect(getRosterAccessState("club-2", now)).resolves.toEqual({ state: "NOT_FOUND" });
    mocks.getCurrentAttendee.mockResolvedValue({ account: null, via: null, sessionId: null });
    await expect(getRosterAccessState("club-1", now)).resolves.toEqual({ state: "SIGN_IN" });
  });

  it("needs the person's own session, an authenticator, and a recent code", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account, via: "staff", sessionId: null });
    await expect(getRosterAccessState("club-1", now)).resolves.toMatchObject({ state: "OWN_SESSION_REQUIRED" });

    mocks.getCurrentAttendee.mockResolvedValue({ account, via: "attendee", sessionId: "session-1" });
    mocks.findEnrollment.mockResolvedValue({ status: "PENDING" });
    await expect(getRosterAccessState("club-1", now)).resolves.toMatchObject({ state: "MFA_SETUP" });

    mocks.findEnrollment.mockResolvedValue({ status: "ACTIVE" });
    mocks.findSession.mockResolvedValue({ secondFactorVerifiedAt: null });
    await expect(getRosterAccessState("club-1", now)).resolves.toMatchObject({ state: "MFA_UNLOCK" });

    const stale = new Date(now.getTime() - (ROSTER_UNLOCK_HOURS * 3_600_000 + 1));
    mocks.findSession.mockResolvedValue({ secondFactorVerifiedAt: stale });
    await expect(getRosterAccessState("club-1", now)).resolves.toMatchObject({ state: "MFA_UNLOCK" });
  });

  it("accepts a passkey as the second step only once passkeys are switched on", async () => {
    mocks.findEnrollment.mockResolvedValue(null);
    mocks.countPasskeys.mockResolvedValue(1);
    mocks.findSession.mockResolvedValue({ secondFactorVerifiedAt: null });
    // A passkey on file doesn't count while an administrator has passkeys off.
    await expect(getRosterAccessState("club-1", now)).resolves.toMatchObject({ state: "MFA_SETUP" });

    mocks.findSettings.mockResolvedValue({ passkeyRpId: "events.imsda.test" });
    await expect(getRosterAccessState("club-1", now)).resolves.toMatchObject({
      state: "MFA_UNLOCK",
      methods: { code: false, passkey: true },
    });

    mocks.findEnrollment.mockResolvedValue({ status: "ACTIVE" });
    await expect(getRosterAccessState("club-1", now)).resolves.toMatchObject({ methods: { code: true, passkey: true } });
  });
});

describe("roster routes", () => {
  it("answers another club's roster with 404, by URL", async () => {
    const response = await GET(request(), clubContext("club-2"));
    expect(response.status).toBe(404);
    expect(mocks.listRoster).not.toHaveBeenCalled();
  });

  it("refuses a locked roster with 403 and adds nothing", async () => {
    mocks.findSession.mockResolvedValue({ secondFactorVerifiedAt: null });
    const response = await POST(request({ firstName: "A", lastName: "B", birthDate: "2014-01-01", attendeeType: "YOUTH", gender: "FEMALE" }), clubContext());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "MFA_UNLOCK_REQUIRED" });
    expect(mocks.addRosterMember).not.toHaveBeenCalled();
  });

  it("adds to the director's own club for the current club year", async () => {
    const response = await POST(request({ firstName: "A", lastName: "B", birthDate: "2014-01-01", attendeeType: "YOUTH", gender: "FEMALE" }), clubContext());
    expect(response.status).toBe(201);
    expect(mocks.addRosterMember).toHaveBeenCalledWith("club-1", expect.stringMatching(/^\d{4}-\d{2}$/), expect.objectContaining({ birthDate: "2014-01-01", gender: "FEMALE" }), { accountId: "director-1" });
  });

  it("rejects cross-origin writes before anything else", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(Response.json({}, { status: 403 }));
    expect((await POST(request({}), clubContext())).status).toBe(403);
    expect(mocks.getCurrentAttendee).not.toHaveBeenCalled();
  });
});

describe("unlocking with an authenticator code", () => {
  it("marks the session unlocked after a correct code", async () => {
    mocks.verifyAttendeeSecondFactor.mockResolvedValue(undefined);
    const response = await UNLOCK(request({ code: "123456" }));
    expect(response.status).toBe(200);
    expect(mocks.updateSession).toHaveBeenCalledWith({ where: { id: "session-1" }, data: { secondFactorVerifiedAt: expect.any(Date) } });
  });

  it("does not unlock on a wrong code, and is rate limited", async () => {
    mocks.verifyAttendeeSecondFactor.mockRejectedValue(new AttendeeMfaError("MFA_CODE_INVALID", "That code is not right."));
    expect((await UNLOCK(request({ code: "000000" }))).status).toBe(400);
    expect(mocks.updateSession).not.toHaveBeenCalled();

    mocks.checkRateLimit.mockResolvedValue({ allowed: false, decisions: [] });
    expect((await UNLOCK(request({ code: "123456" }))).status).toBe(429);
  });

  it("is only for directors signed in with their own session", async () => {
    mocks.listDirectedClubs.mockResolvedValue([]);
    expect((await UNLOCK(request({ code: "123456" }))).status).toBe(404);
    mocks.getCurrentAttendee.mockResolvedValue({ account, via: "staff", sessionId: null });
    expect((await UNLOCK(request({ code: "123456" }))).status).toBe(401);
    expect(mocks.verifyAttendeeSecondFactor).not.toHaveBeenCalled();
  });
});
