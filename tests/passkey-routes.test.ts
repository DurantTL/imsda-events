import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentAttendee: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  checkRateLimit: vi.fn(),
  finishPasskeyVerification: vi.fn(),
  markRosterUnlocked: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/rate-limit/service", () => ({ checkAttendeeRosterUnlockRateLimit: mocks.checkRateLimit }));
vi.mock("@/modules/club-rosters/access", () => ({ markRosterUnlocked: mocks.markRosterUnlocked }));
vi.mock("@/modules/attendee-accounts/passkeys", async () => {
  const actual = await vi.importActual<typeof import("@/modules/attendee-accounts/passkeys")>("@/modules/attendee-accounts/passkeys");
  return { ...actual, finishPasskeyVerification: mocks.finishPasskeyVerification };
});

import { POST } from "@/app/api/attendee/passkeys/verification/route";
import { PasskeyError } from "@/modules/attendee-accounts/passkeys";

const account = { id: "account-1", verifiedEmail: "director@example.test", displayName: "Test Director" };
const body = { response: { id: "cred-1", rawId: "cred-1", type: "public-key", response: { clientDataJSON: "a", authenticatorData: "b", signature: "c" } } };
const request = (payload: unknown = body) => new Request("https://events.imsda.test/api/attendee/passkeys/verification", {
  method: "POST",
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: JSON.stringify(payload),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentAttendee.mockResolvedValue({ account, via: "attendee", sessionId: "session-1" });
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.checkRateLimit.mockResolvedValue({ allowed: true, decisions: [] });
  mocks.finishPasskeyVerification.mockResolvedValue(undefined);
});

describe("passkey verification route", () => {
  it("unlocks this session after the passkey checks out", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.finishPasskeyVerification).toHaveBeenCalledWith(account, "session-1", "https://events.imsda.test", body.response);
    expect(mocks.markRosterUnlocked).toHaveBeenCalledWith("session-1");
  });

  it("never unlocks when the passkey fails", async () => {
    mocks.finishPasskeyVerification.mockRejectedValueOnce(new PasskeyError("PASSKEY_NOT_VERIFIED", "No."));
    const response = await POST(request());
    expect(response.status).toBe(400);
    expect(mocks.markRosterUnlocked).not.toHaveBeenCalled();
  });

  it("needs the person's own sign-in, not a staff view", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account, via: "staff", sessionId: null });
    expect((await POST(request())).status).toBe(401);
    expect(mocks.finishPasskeyVerification).not.toHaveBeenCalled();
  });

  it("is rate limited and rejects malformed responses", async () => {
    mocks.checkRateLimit.mockResolvedValueOnce({ allowed: false, decisions: [] });
    expect((await POST(request())).status).toBe(429);
    expect((await POST(request({ response: { id: "x" } }))).status).toBe(400);
    expect(mocks.finishPasskeyVerification).not.toHaveBeenCalled();
  });

  it("refuses cross-origin requests", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(Response.json({}, { status: 403 }));
    expect((await POST(request())).status).toBe(403);
  });
});
