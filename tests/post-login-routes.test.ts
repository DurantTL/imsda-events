import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level coverage for role-aware post-login routing (#108 queue 1): the
 * login and MFA-verify routes return a `redirectTo` only once a session is
 * issued, a bad `next` never blocks or steers sign-in, and a routing failure
 * after sign-in falls back instead of failing the request.
 *
 * The real `resolvePostLoginDestination` and `resolveLoginDestination` run;
 * only the database lookups, cookies, rate limits, and credential checks are
 * stubbed. All data is synthetic.
 */

const mocks = vi.hoisted(() => {
  class MockMfaError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
      this.name = "MfaError";
    }
  }
  return {
    MfaError: MockMfaError,
    authenticateWithPassword: vi.fn(),
    issueMfaChallenge: vi.fn(),
    completeMfaChallenge: vi.fn(),
    describeMfaChallenge: vi.fn(),
    beginEnrollmentFromChallenge: vi.fn(),
    checkLoginClientRateLimit: vi.fn(),
    checkLoginAccountRateLimit: vi.fn(),
    listEventsForUser: vi.fn(),
    cookieGet: vi.fn(),
    cookieSet: vi.fn(),
    logError: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: mocks.cookieGet, set: mocks.cookieSet })),
}));
vi.mock("@/lib/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logger")>()),
  logError: mocks.logError,
}));
vi.mock("@/modules/access/auth-service", () => ({
  authenticateWithPassword: mocks.authenticateWithPassword,
}));
vi.mock("@/modules/access/mfa-service", () => ({
  MfaError: mocks.MfaError,
  issueMfaChallenge: mocks.issueMfaChallenge,
  completeMfaChallenge: mocks.completeMfaChallenge,
  describeMfaChallenge: mocks.describeMfaChallenge,
  beginEnrollmentFromChallenge: mocks.beginEnrollmentFromChallenge,
}));
vi.mock("@/modules/access/session-store", () => ({
  SESSION_COOKIE_NAME: "imsda_session",
  SESSION_LIFETIME_SECONDS: 28_800,
}));
vi.mock("@/modules/rate-limit/service", () => ({
  checkLoginClientRateLimit: mocks.checkLoginClientRateLimit,
  checkLoginAccountRateLimit: mocks.checkLoginAccountRateLimit,
}));
vi.mock("@/modules/events/repository", () => ({
  listEventsForUser: mocks.listEventsForUser,
}));

import { POST as login } from "@/app/api/auth/login/route";
import { POST as mfaChallenge } from "@/app/api/auth/mfa/challenge/route";

const allowed = {
  allowed: true,
  decisions: [{
    policy: "auth.login.client",
    allowed: true,
    limit: 5,
    remaining: 4,
    count: 1,
    windowSeconds: 900,
    resetAfterSeconds: 900,
  }],
};

function post(path: string, body: unknown) {
  return new Request(`https://events.imsda.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://events.imsda.test",
      "user-agent": "post-login-route-test",
    },
    body: JSON.stringify(body),
  });
}

const credentials = { email: "staff@imsda-events.test", password: "synthetic password" };
const challengeToken = "c".repeat(43);

function signedInSession(globalRole: "SYSTEM_ADMIN" | null = null) {
  return {
    outcome: "session",
    userId: "usr_synthetic_staff",
    globalRole,
    session: { token: "synthetic-session-token", expiresAt: new Date("2030-01-01T00:00:00Z") },
  };
}

beforeEach(() => {
  mocks.checkLoginClientRateLimit.mockResolvedValue(allowed);
  mocks.checkLoginAccountRateLimit.mockResolvedValue(allowed);
  mocks.authenticateWithPassword.mockResolvedValue(null);
  mocks.listEventsForUser.mockResolvedValue([{ id: "evt_only" }]);
  mocks.cookieGet.mockReturnValue(undefined);
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("POST /api/auth/login destination", () => {
  it("returns the role-routed redirectTo on a successful sign-in", async () => {
    mocks.authenticateWithPassword.mockResolvedValue(signedInSession());

    const response = await login(post("/api/auth/login", credentials));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, redirectTo: "/overview?event=evt_only" });
    expect(mocks.cookieSet).toHaveBeenCalledWith(
      "imsda_session",
      "synthetic-session-token",
      expect.objectContaining({ httpOnly: true, sameSite: "lax" }),
    );
  });

  it("sends a system administrator to /admin", async () => {
    mocks.authenticateWithPassword.mockResolvedValue(signedInSession("SYSTEM_ADMIN"));

    const response = await login(post("/api/auth/login", credentials));

    expect((await response.json()).redirectTo).toBe("/admin");
  });

  it("honors a safe next ahead of role routing", async () => {
    mocks.authenticateWithPassword.mockResolvedValue(signedInSession());

    const response = await login(post("/api/auth/login", { ...credentials, next: "/people?event=evt_only" }));

    expect((await response.json()).redirectTo).toBe("/people?event=evt_only");
  });

  it("has no redirectTo when a second factor is still required", async () => {
    mocks.authenticateWithPassword.mockResolvedValue({ outcome: "mfa", userId: "usr_synthetic_staff", gate: "challenge" });
    mocks.issueMfaChallenge.mockResolvedValue({
      challengeToken,
      expiresAt: new Date("2030-01-01T00:10:00Z"),
    });

    const response = await login(post("/api/auth/login", { ...credentials, next: "/people" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.mfa.required).toBe(true);
    expect(body).not.toHaveProperty("redirectTo");
    expect(mocks.cookieSet).not.toHaveBeenCalled();
    expect(mocks.listEventsForUser).not.toHaveBeenCalled();
  });

  it.each([
    ["an absolute URL", "https://evil.example/phish"],
    ["a protocol-relative URL", "//evil.example"],
    ["an encoded protocol-relative URL", "/%2F%2Fevil.example"],
    ["a backslash path", "/\\evil.example"],
    ["an oversized value", `/${"a".repeat(3000)}`],
    ["a repeated value", ["/people", "/finance"]],
    ["a non-string value", 42],
  ])("ignores %s in next and still signs in with role routing", async (_label, next) => {
    mocks.authenticateWithPassword.mockResolvedValue(signedInSession());

    const response = await login(post("/api/auth/login", { ...credentials, next }));

    expect(response.status).toBe(200);
    expect((await response.json()).redirectTo).toBe("/overview?event=evt_only");
  });

  it("returns an identical 401 body for a wrong password and an unknown account", async () => {
    mocks.authenticateWithPassword.mockResolvedValue(null);

    const wrongPassword = await login(post("/api/auth/login", { ...credentials, password: "not it" }));
    const unknownUser = await login(post("/api/auth/login", { email: "nobody@imsda-events.test", password: "not it" }));

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(await wrongPassword.text()).toBe(await unknownUser.text());
  });

  it("falls back to /overview when routing fails after the session is issued", async () => {
    mocks.authenticateWithPassword.mockResolvedValue(signedInSession());
    mocks.listEventsForUser.mockRejectedValue(new Error("synthetic database outage"));

    const response = await login(post("/api/auth/login", credentials));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, redirectTo: "/overview" });
    expect(mocks.cookieSet).toHaveBeenCalledOnce();
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
  });
});

describe("POST /api/auth/mfa/challenge destination", () => {
  it("returns redirectTo after a verified code", async () => {
    mocks.completeMfaChallenge.mockResolvedValue({
      userId: "usr_synthetic_staff",
      globalRole: null,
      session: { token: "synthetic-session-token", expiresAt: new Date("2030-01-01T00:00:00Z") },
      usedRecoveryCode: false,
    });

    const response = await mfaChallenge(post("/api/auth/mfa/challenge", {
      challengeToken,
      action: "verify",
      code: "123456",
      next: "/check-in?event=evt_only",
    }));

    expect(response.status).toBe(200);
    expect((await response.json()).redirectTo).toBe("/check-in?event=evt_only");
  });

  it("ignores an oversized next instead of rejecting the code", async () => {
    mocks.completeMfaChallenge.mockResolvedValue({
      userId: "usr_synthetic_staff",
      globalRole: null,
      session: { token: "synthetic-session-token", expiresAt: new Date("2030-01-01T00:00:00Z") },
      usedRecoveryCode: false,
    });

    const response = await mfaChallenge(post("/api/auth/mfa/challenge", {
      challengeToken,
      action: "verify",
      code: "123456",
      next: `/${"a".repeat(3000)}`,
    }));

    expect(response.status).toBe(200);
    expect((await response.json()).redirectTo).toBe("/overview?event=evt_only");
  });

  it("still returns enrolment recovery codes, with the /overview fallback, when routing fails", async () => {
    const recoveryCodes = ["11111-11111", "22222-22222"];
    mocks.completeMfaChallenge.mockResolvedValue({
      userId: "usr_synthetic_staff",
      globalRole: null,
      session: { token: "synthetic-session-token", expiresAt: new Date("2030-01-01T00:00:00Z") },
      usedRecoveryCode: false,
      recoveryCodes,
    });
    mocks.listEventsForUser.mockRejectedValue(new Error("synthetic database outage"));

    const response = await mfaChallenge(post("/api/auth/mfa/challenge", {
      challengeToken,
      action: "verify",
      code: "123456",
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.recoveryCodes).toEqual(recoveryCodes);
    expect(body.redirectTo).toBe("/overview");
    expect(mocks.cookieSet).toHaveBeenCalledOnce();
  });
});
