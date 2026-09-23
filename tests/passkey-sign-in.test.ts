import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  challengeDeleteMany: vi.fn(),
  challengeCreate: vi.fn(),
  challengeFindFirst: vi.fn(),
  challengeUpdateMany: vi.fn(),
  passkeyFindFirst: vi.fn(),
  passkeyUpdate: vi.fn(),
  createAttendeeSession: vi.fn(),
  writeAuditLog: vi.fn(),
  cookieGet: vi.fn(),
  cookieSet: vi.fn(),
  cookieDelete: vi.fn(),
  checkRateLimit: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
}));
const webauthn = vi.hoisted(() => ({
  generateAuthenticationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
  generateRegistrationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@simplewebauthn/server", () => webauthn);
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    platformSettings: { findUnique: mocks.settings },
    attendeePasskeyChallenge: {
      deleteMany: mocks.challengeDeleteMany,
      create: mocks.challengeCreate,
      findFirst: mocks.challengeFindFirst,
      updateMany: mocks.challengeUpdateMany,
    },
    attendeePasskey: { findFirst: mocks.passkeyFindFirst, update: mocks.passkeyUpdate },
  }),
}));
vi.mock("@/modules/attendee-accounts/session-store", async () => {
  const actual = await vi.importActual<typeof import("@/modules/attendee-accounts/session-store")>("@/modules/attendee-accounts/session-store");
  return { ...actual, createAttendeeSession: mocks.createAttendeeSession };
});
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: mocks.cookieGet, set: mocks.cookieSet, delete: mocks.cookieDelete }) }));
vi.mock("@/modules/rate-limit/service", () => ({ checkAttendeePasskeySignInRateLimit: mocks.checkRateLimit }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));

import { POST as SIGN_IN } from "@/app/api/attendee/passkeys/sign-in/route";
import { POST as OPTIONS } from "@/app/api/attendee/passkeys/sign-in/options/route";
import { PASSKEY_SIGN_IN_COOKIE } from "@/modules/attendee-accounts/passkey-sign-in";

const origin = "https://events.imsda.test";
const activeAccount = { id: "account-1", status: "ACTIVE", emailVerifiedAt: new Date("2026-01-01"), disabledAt: null };
const passkey = {
  id: "pk-1",
  accountId: "account-1",
  credentialId: "cred-1",
  publicKey: Buffer.from([1, 2, 3]),
  counter: BigInt(4),
  transports: ["internal"],
  account: activeAccount,
};
const answer = (userHandle?: string) => ({
  response: {
    id: "cred-1",
    rawId: "cred-1",
    type: "public-key",
    response: { clientDataJSON: "a", authenticatorData: "b", signature: "c", ...(userHandle ? { userHandle } : {}) },
  },
});
const post = (url: string, body: unknown = {}) => new Request(`${origin}${url}`, {
  method: "POST",
  headers: { origin, "content-type": "application/json", "user-agent": "test" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.mockResolvedValue({ passkeyRpId: "events.imsda.test" });
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.checkRateLimit.mockResolvedValue({ allowed: true, decisions: [] });
  mocks.challengeCreate.mockResolvedValue({ id: "challenge-1" });
  mocks.challengeFindFirst.mockResolvedValue({ id: "challenge-1", challenge: "expected-challenge" });
  mocks.challengeUpdateMany.mockResolvedValue({ count: 1 });
  mocks.passkeyFindFirst.mockResolvedValue(passkey);
  mocks.cookieGet.mockReturnValue({ value: "challenge-1" });
  webauthn.generateAuthenticationOptions.mockResolvedValue({ challenge: "expected-challenge", rpId: "events.imsda.test" });
  webauthn.verifyAuthenticationResponse.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 5 } });
  mocks.createAttendeeSession.mockResolvedValue({ token: "session-token", expiresAt: new Date("2026-10-07T00:00:00Z") });
});

describe("passkey sign-in (#374)", () => {
  it("offers a prompt for any of this site's passkeys and ties it to the browser", async () => {
    const response = await OPTIONS(post("/api/attendee/passkeys/sign-in/options"));
    expect(response.status).toBe(200);
    expect(webauthn.generateAuthenticationOptions).toHaveBeenCalledWith({ rpID: "events.imsda.test", userVerification: "required" });
    expect(mocks.challengeCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ purpose: "SIGN_IN" }) }));
    expect(mocks.challengeCreate.mock.calls[0][0].data.sessionId).toBeUndefined();
    expect(mocks.cookieSet).toHaveBeenCalledWith(PASSKEY_SIGN_IN_COOKIE, "challenge-1", expect.objectContaining({ httpOnly: true, sameSite: "strict" }));
  });

  it("stays hidden until the passkey domain is set", async () => {
    mocks.settings.mockResolvedValue({ passkeyRpId: null });
    expect((await OPTIONS(post("/api/attendee/passkeys/sign-in/options"))).status).toBe(409);
    expect(mocks.challengeCreate).not.toHaveBeenCalled();
  });

  it("signs in and starts the session with the second step already passed", async () => {
    const response = await SIGN_IN(post("/api/attendee/passkeys/sign-in", answer(Buffer.from("account-1").toString("base64url"))));
    expect(response.status).toBe(200);
    expect(webauthn.verifyAuthenticationResponse).toHaveBeenCalledWith(expect.objectContaining({
      expectedChallenge: "expected-challenge",
      expectedOrigin: origin,
      expectedRPID: "events.imsda.test",
      requireUserVerification: true,
    }));
    expect(mocks.challengeUpdateMany).toHaveBeenCalledWith({ where: { id: "challenge-1", usedAt: null }, data: { usedAt: expect.any(Date) } });
    expect(mocks.createAttendeeSession).toHaveBeenCalledWith("account-1", "test", { secondFactorVerifiedAt: expect.any(Date) });
    expect(mocks.cookieSet).toHaveBeenCalledWith(expect.any(String), "session-token", expect.objectContaining({ httpOnly: true }));
    expect(mocks.passkeyUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ counter: BigInt(5) }) }));
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "ATTENDEE_PASSKEY_SIGN_IN", metadata: { actorAttendeeAccountId: "account-1" } }));
    expect(mocks.cookieDelete).toHaveBeenCalled();
  });

  const refused = async () => {
    const response = await SIGN_IN(post("/api/attendee/passkeys/sign-in", answer()));
    expect(response.status).toBe(400);
    expect(mocks.createAttendeeSession).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalledWith(expect.any(String), "session-token", expect.anything());
    return (await response.json()) as { error: string; message: string };
  };

  it("never signs in with a failed signature", async () => {
    webauthn.verifyAuthenticationResponse.mockResolvedValue({ verified: false });
    expect((await refused()).error).toBe("PASSKEY_NOT_VERIFIED");
  });

  it("never signs in when the library throws", async () => {
    webauthn.verifyAuthenticationResponse.mockRejectedValue(new Error("bad signature"));
    expect((await refused()).error).toBe("PASSKEY_NOT_VERIFIED");
  });

  it("treats unknown, revoked, and disabled-account passkeys alike", async () => {
    mocks.passkeyFindFirst.mockResolvedValueOnce(null);
    const unknown = await refused();
    mocks.passkeyFindFirst.mockResolvedValueOnce({ ...passkey, account: { ...activeAccount, disabledAt: new Date() } });
    const disabled = await refused();
    expect(unknown).toEqual(disabled);
    expect(mocks.passkeyFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { credentialId: "cred-1", revokedAt: null } }));
    expect(webauthn.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it("refuses a passkey that names a different account", async () => {
    const response = await SIGN_IN(post("/api/attendee/passkeys/sign-in", answer(Buffer.from("account-2").toString("base64url"))));
    expect(response.status).toBe(400);
    expect(mocks.createAttendeeSession).not.toHaveBeenCalled();
  });

  it("needs this browser's unexpired, unused prompt", async () => {
    mocks.cookieGet.mockReturnValueOnce(undefined);
    expect((await refused()).error).toBe("CHALLENGE_EXPIRED");
    mocks.challengeFindFirst.mockResolvedValueOnce(null);
    expect((await refused()).error).toBe("CHALLENGE_EXPIRED");
    mocks.challengeUpdateMany.mockResolvedValueOnce({ count: 0 });
    expect((await refused()).error).toBe("CHALLENGE_EXPIRED");
    expect(mocks.challengeFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "challenge-1", purpose: "SIGN_IN", sessionId: null, usedAt: null }),
    }));
  });

  it("is rate limited and refuses cross-origin requests", async () => {
    mocks.checkRateLimit.mockResolvedValueOnce({ allowed: false, decisions: [] });
    expect((await SIGN_IN(post("/api/attendee/passkeys/sign-in", answer()))).status).toBe(429);
    mocks.rejectCrossOriginRequest.mockReturnValueOnce(Response.json({}, { status: 403 }));
    expect((await OPTIONS(post("/api/attendee/passkeys/sign-in/options"))).status).toBe(403);
    expect(mocks.createAttendeeSession).not.toHaveBeenCalled();
  });
});
