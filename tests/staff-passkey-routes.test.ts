import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireOwnStaffSession: vi.fn(),
  beginPasskeyRegistration: vi.fn(),
  finishPasskeyRegistration: vi.fn(),
  renamePasskey: vi.fn(),
  removePasskey: vi.fn(),
  beginPasskeySignIn: vi.fn(),
  finishPasskeySignIn: vi.fn(),
  checkRateLimit: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  resolvePostLoginDestination: vi.fn(),
  cookieGet: vi.fn(),
  cookieSet: vi.fn(),
  cookieDelete: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/rate-limit/service", () => ({ checkStaffPasskeySignInRateLimit: mocks.checkRateLimit }));
vi.mock("@/modules/access/post-login-destination", () => ({ resolvePostLoginDestination: mocks.resolvePostLoginDestination }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: mocks.cookieGet, set: mocks.cookieSet, delete: mocks.cookieDelete }) }));
vi.mock("@/modules/access/passkey-api", async () => {
  const actual = await vi.importActual<typeof import("@/modules/access/passkey-api")>("@/modules/access/passkey-api");
  return { ...actual, requireOwnStaffSession: mocks.requireOwnStaffSession };
});
vi.mock("@/modules/access/passkeys", () => ({
  beginPasskeyRegistration: mocks.beginPasskeyRegistration,
  finishPasskeyRegistration: mocks.finishPasskeyRegistration,
  renamePasskey: mocks.renamePasskey,
  removePasskey: mocks.removePasskey,
  beginPasskeySignIn: mocks.beginPasskeySignIn,
  finishPasskeySignIn: mocks.finishPasskeySignIn,
  PasskeyError: class PasskeyError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

import { POST as REGISTRATION_OPTIONS } from "@/app/api/auth/passkeys/registration/options/route";
import { POST as REGISTRATION } from "@/app/api/auth/passkeys/registration/route";
import { PATCH as RENAME, DELETE as REMOVE } from "@/app/api/auth/passkeys/[passkeyId]/route";
import { POST as SIGN_IN_OPTIONS } from "@/app/api/auth/passkeys/sign-in/options/route";
import { POST as SIGN_IN } from "@/app/api/auth/passkeys/sign-in/route";
import { STAFF_PASSKEY_SIGN_IN_COOKIE } from "@/modules/access/passkey-sign-in";
import { PasskeyError } from "@/modules/access/passkeys";

const origin = "https://events.imsda.test";
const account = { id: "user-1", email: "director@imsda.test", displayName: "Test Director" };
const registrationBody = { response: { id: "cred-1", rawId: "cred-1", type: "public-key", response: { clientDataJSON: "a", attestationObject: "b" } } };
const verificationBody = { response: { id: "cred-1", rawId: "cred-1", type: "public-key", response: { clientDataJSON: "a", authenticatorData: "b", signature: "c" } } };
const post = (url: string, body: unknown = {}) => new Request(`${origin}${url}`, {
  method: "POST",
  headers: { origin, "content-type": "application/json", "user-agent": "test" },
  body: JSON.stringify(body),
});
const patch = (url: string, body: unknown = {}) => new Request(`${origin}${url}`, {
  method: "PATCH",
  headers: { origin, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const del = (url: string) => new Request(`${origin}${url}`, { method: "DELETE", headers: { origin } });
const params = (passkeyId: string) => ({ params: Promise.resolve({ passkeyId }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.checkRateLimit.mockResolvedValue({ allowed: true, decisions: [] });
  mocks.requireOwnStaffSession.mockResolvedValue({ account, sessionId: "session-1" });
  mocks.cookieGet.mockReturnValue({ value: "challenge-1" });
  mocks.beginPasskeySignIn.mockResolvedValue({ options: { challenge: "auth-challenge" }, challengeId: "challenge-1" });
  mocks.finishPasskeySignIn.mockResolvedValue({ userId: "user-1", globalRole: null, session: { token: "session-token", expiresAt: new Date("2026-10-07T00:00:00Z") } });
  mocks.resolvePostLoginDestination.mockResolvedValue("/overview?event=e1");
});

describe("staff passkey management routes", () => {
  it("requires the caller's own session to start registration", async () => {
    mocks.beginPasskeyRegistration.mockResolvedValue({ challenge: "reg-challenge" });
    const response = await REGISTRATION_OPTIONS(post("/api/auth/passkeys/registration/options"));
    expect(response.status).toBe(200);
    expect(mocks.beginPasskeyRegistration).toHaveBeenCalledWith(account, "session-1", origin);
  });

  it("refuses registration options without a signed-in session", async () => {
    mocks.requireOwnStaffSession.mockRejectedValue(new (await import("@/modules/access/passkey-api")).PasskeySessionError());
    const response = await REGISTRATION_OPTIONS(post("/api/auth/passkeys/registration/options"));
    expect(response.status).toBe(401);
  });

  it("finishes registration and never logs the credential id", async () => {
    mocks.finishPasskeyRegistration.mockResolvedValue([{ id: "pk-1", name: "Laptop", createdAt: "2026-10-01T00:00:00Z", lastUsedAt: null, backedUp: false }]);
    const response = await REGISTRATION(post("/api/auth/passkeys/registration", registrationBody));
    expect(response.status).toBe(201);
    expect(mocks.finishPasskeyRegistration).toHaveBeenCalledWith(account, "session-1", origin, expect.objectContaining({ response: registrationBody.response }));
  });

  it("rejects a malformed registration body", async () => {
    const response = await REGISTRATION(post("/api/auth/passkeys/registration", { response: { id: "x" } }));
    expect(response.status).toBe(400);
    expect(mocks.finishPasskeyRegistration).not.toHaveBeenCalled();
  });

  it("renames a passkey", async () => {
    mocks.renamePasskey.mockResolvedValue([{ id: "pk-1", name: "Renamed", createdAt: "2026-10-01T00:00:00Z", lastUsedAt: null, backedUp: false }]);
    const response = await RENAME(patch("/api/auth/passkeys/pk-1", { name: "Renamed" }), params("pk-1"));
    expect(response.status).toBe(200);
    expect(mocks.renamePasskey).toHaveBeenCalledWith(account, "pk-1", "Renamed");
  });

  it("removes a passkey", async () => {
    mocks.removePasskey.mockResolvedValue([]);
    const response = await REMOVE(del("/api/auth/passkeys/pk-1"), params("pk-1"));
    expect(response.status).toBe(200);
    expect(mocks.removePasskey).toHaveBeenCalledWith(account, "pk-1");
  });

  it("reports the last-sign-in-method refusal", async () => {
    mocks.removePasskey.mockRejectedValue(new PasskeyError("LAST_SIGN_IN_METHOD", "No."));
    const response = await REMOVE(del("/api/auth/passkeys/pk-1"), params("pk-1"));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("LAST_SIGN_IN_METHOD");
  });

  it("refuses cross-origin management requests", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(Response.json({}, { status: 403 }));
    expect((await REGISTRATION_OPTIONS(post("/api/auth/passkeys/registration/options"))).status).toBe(403);
    expect((await REGISTRATION(post("/api/auth/passkeys/registration", registrationBody))).status).toBe(403);
    expect((await RENAME(patch("/api/auth/passkeys/pk-1", { name: "x" }), params("pk-1"))).status).toBe(403);
    expect((await REMOVE(del("/api/auth/passkeys/pk-1"), params("pk-1"))).status).toBe(403);
  });
});

describe("staff passkey sign-in (#429)", () => {
  it("offers a prompt for any of this site's staff passkeys and ties it to the browser", async () => {
    const response = await SIGN_IN_OPTIONS(post("/api/auth/passkeys/sign-in/options"));
    expect(response.status).toBe(200);
    expect(mocks.beginPasskeySignIn).toHaveBeenCalledWith(origin);
    expect(mocks.cookieSet).toHaveBeenCalledWith(STAFF_PASSKEY_SIGN_IN_COOKIE, "challenge-1", expect.objectContaining({ httpOnly: true, sameSite: "strict" }));
  });

  it("stays hidden until the passkey domain is set", async () => {
    mocks.beginPasskeySignIn.mockRejectedValue(new PasskeyError("PASSKEYS_NOT_AVAILABLE", "No."));
    expect((await SIGN_IN_OPTIONS(post("/api/auth/passkeys/sign-in/options"))).status).toBe(409);
  });

  it("signs in, uses #108 routing (resolvePostLoginDestination and the /overview fallback), and audits via the service", async () => {
    const response = await SIGN_IN(post("/api/auth/passkeys/sign-in", { ...verificationBody, next: "/staff?event=e1" }));
    const body = await response.json() as { ok: boolean; redirectTo: string };
    expect(response.status).toBe(200);
    expect(body.redirectTo).toBe("/overview?event=e1");
    expect(mocks.resolvePostLoginDestination).toHaveBeenCalledWith({ id: "user-1", globalRole: null }, { returnTo: "/staff?event=e1" });
    expect(mocks.cookieSet).toHaveBeenCalledWith(expect.any(String), "session-token", expect.objectContaining({ httpOnly: true }));
    expect(mocks.cookieDelete).toHaveBeenCalledWith(expect.objectContaining({ name: STAFF_PASSKEY_SIGN_IN_COOKIE }));
  });

  it("falls back to /overview when destination routing fails after the session is already set", async () => {
    mocks.resolvePostLoginDestination.mockRejectedValue(new Error("boom"));
    const response = await SIGN_IN(post("/api/auth/passkeys/sign-in", verificationBody));
    const body = await response.json() as { redirectTo: string };
    expect(response.status).toBe(200);
    expect(body.redirectTo).toBe("/overview");
  });

  const refused = async () => {
    const response = await SIGN_IN(post("/api/auth/passkeys/sign-in", verificationBody));
    expect(response.status).toBe(400);
    expect(mocks.cookieSet).not.toHaveBeenCalledWith(expect.any(String), "session-token", expect.anything());
    return (await response.json()) as { error: string };
  };

  it("never signs in when the passkey doesn't verify", async () => {
    mocks.finishPasskeySignIn.mockRejectedValue(new PasskeyError("PASSKEY_NOT_VERIFIED", "No."));
    expect((await refused()).error).toBe("PASSKEY_NOT_VERIFIED");
  });

  it("needs this browser's unexpired, unused prompt", async () => {
    mocks.finishPasskeySignIn.mockRejectedValue(new PasskeyError("CHALLENGE_EXPIRED", "No."));
    expect((await refused()).error).toBe("CHALLENGE_EXPIRED");
  });

  it("is rate limited on both options and verify", async () => {
    mocks.checkRateLimit.mockResolvedValueOnce({ allowed: false, decisions: [] });
    expect((await SIGN_IN_OPTIONS(post("/api/auth/passkeys/sign-in/options"))).status).toBe(429);
    mocks.checkRateLimit.mockResolvedValueOnce({ allowed: false, decisions: [] });
    expect((await SIGN_IN(post("/api/auth/passkeys/sign-in", verificationBody))).status).toBe(429);
    expect(mocks.finishPasskeySignIn).not.toHaveBeenCalled();
  });

  it("refuses cross-origin sign-in requests", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(Response.json({}, { status: 403 }));
    expect((await SIGN_IN_OPTIONS(post("/api/auth/passkeys/sign-in/options"))).status).toBe(403);
    expect((await SIGN_IN(post("/api/auth/passkeys/sign-in", verificationBody))).status).toBe(403);
  });
});
