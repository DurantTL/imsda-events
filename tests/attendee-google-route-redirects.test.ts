import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookieGet: vi.fn(),
  cookieSet: vi.fn(),
  cookieDelete: vi.fn(),
  getServerEnv: vi.fn(),
  isGoogleSignInConfigured: vi.fn(),
  beginGoogleAuthorization: vi.fn(),
  exchangeGoogleAuthorizationCode: vi.fn(),
  verifyGoogleIdToken: vi.fn(),
  signInWithGoogle: vi.fn(),
  checkStartRateLimit: vi.fn(),
  checkCallbackRateLimit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: mocks.cookieGet,
    set: mocks.cookieSet,
    delete: mocks.cookieDelete,
  })),
}));
vi.mock("@/lib/env", () => ({
  getServerEnv: mocks.getServerEnv,
}));
vi.mock("@/lib/logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("@/lib/request-context", () => ({
  withRequestContext: <Handler>(handler: Handler) => handler,
}));
vi.mock("@/integrations/oauth/google", () => ({
  isGoogleSignInConfigured: mocks.isGoogleSignInConfigured,
  beginGoogleAuthorization: mocks.beginGoogleAuthorization,
  exchangeGoogleAuthorizationCode: mocks.exchangeGoogleAuthorizationCode,
  verifyGoogleIdToken: mocks.verifyGoogleIdToken,
}));
vi.mock("@/modules/attendee-accounts/federated-sign-in", () => ({
  signInWithGoogle: mocks.signInWithGoogle,
}));
vi.mock("@/modules/attendee-accounts/session-store", () => ({
  ATTENDEE_OAUTH_COOKIE_NAME: "imsda_attendee_oauth",
  ATTENDEE_PENDING_COOKIE_NAME: "imsda_attendee_pending",
  ATTENDEE_SESSION_COOKIE_NAME: "imsda_attendee_session",
  ATTENDEE_SESSION_LIFETIME_SECONDS: 1_209_600,
}));
vi.mock("@/modules/rate-limit/service", () => ({
  checkAttendeeOAuthStartRateLimit: mocks.checkStartRateLimit,
  checkAttendeeOAuthCallbackRateLimit: mocks.checkCallbackRateLimit,
}));

import { GET as callback } from "@/app/api/attendee/oauth/google/callback/route";
import { GET as start } from "@/app/api/attendee/oauth/google/start/route";

const allowed = {
  allowed: true,
  decisions: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getServerEnv.mockReturnValue({
    APP_BASE_URL: "https://events.imsda.org",
  });
  mocks.isGoogleSignInConfigured.mockReturnValue(true);
  mocks.checkStartRateLimit.mockResolvedValue(allowed);
  mocks.checkCallbackRateLimit.mockResolvedValue(allowed);
  mocks.cookieGet.mockReturnValue({
    value: JSON.stringify({
      state: "expected-state",
      nonce: "expected-nonce",
      codeVerifier: "expected-verifier",
    }),
  });
  mocks.exchangeGoogleAuthorizationCode.mockResolvedValue("id-token");
  mocks.verifyGoogleIdToken.mockResolvedValue({
    subject: "google-subject",
    email: "person@example.test",
    emailVerified: true,
    name: "Person",
  });
  mocks.signInWithGoogle.mockResolvedValue({
    outcome: "signed-in",
    linkage: "existing-identity",
    session: {
      token: "attendee-session-token",
      expiresAt: new Date("2026-08-13T14:00:00.000Z"),
    },
  });
});

describe("Google attendee route redirects", () => {
  it("returns a successful callback to the public account URL", async () => {
    const request = new Request(
      "http://10.42.0.19:3100/api/attendee/oauth/google/callback"
        + "?code=authorization-code&state=expected-state",
      { headers: { "user-agent": "redirect-test" } },
    );

    const response = await callback(request);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://events.imsda.org/account");
  });

  it("returns callback failures to the public sign-in URL", async () => {
    const response = await callback(new Request(
      "http://10.42.0.19:3100/api/attendee/oauth/google/callback?state=wrong-state",
    ));

    expect(response.status).toBe(303);
    expect(response.headers.get("location"))
      .toBe("https://events.imsda.org/account/sign-in?error=google-expired");
  });

  it("returns an unavailable start to the public sign-in URL", async () => {
    mocks.isGoogleSignInConfigured.mockReturnValue(false);

    const response = await start(new Request(
      "http://10.42.0.19:3100/api/attendee/oauth/google/start",
    ));

    expect(response.status).toBe(303);
    expect(response.headers.get("location"))
      .toBe("https://events.imsda.org/account/sign-in?error=google-unavailable");
  });

  describe("carrying a destination (#568)", () => {
    const handoff = JSON.stringify({ state: "expected-state", nonce: "expected-nonce", codeVerifier: "expected-verifier" });
    const callbackRequest = () => new Request(
      "http://10.42.0.19:3100/api/attendee/oauth/google/callback?code=authorization-code&state=expected-state",
    );
    const withNextCookie = (value: string | undefined) => mocks.cookieGet.mockImplementation((name: string) => {
      if (name === "imsda_attendee_oauth") return { value: handoff };
      if (name === "imsda_attendee_oauth_next" && value !== undefined) return { value };
      return undefined;
    });

    beforeEach(() => {
      mocks.beginGoogleAuthorization.mockReturnValue({
        state: "s", nonce: "n", codeVerifier: "v", authorizationUrl: "https://accounts.google.test/auth",
      });
    });

    it("start stores a valid next in a short-lived httpOnly Lax cookie, leaving state alone", async () => {
      const roster = "/account/clubs/club-1/roster";
      await start(new Request(`http://10.42.0.19:3100/api/attendee/oauth/google/start?next=${encodeURIComponent(roster)}`));
      const call = mocks.cookieSet.mock.calls.find(([name]) => name === "imsda_attendee_oauth_next");
      expect(call?.[1]).toBe(roster);
      expect(call?.[2]).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/api/attendee/oauth" });
      expect(call?.[2].maxAge).toBeGreaterThan(0);
      const handoffCall = mocks.cookieSet.mock.calls.find(([name]) => name === "imsda_attendee_oauth");
      expect(JSON.parse(handoffCall?.[1])).toEqual({ state: "s", nonce: "n", codeVerifier: "v" });
    });

    it("start refuses an off-site or dot-segment next", async () => {
      for (const next of ["https://evil.example/", "/account/../admin"]) {
        mocks.cookieSet.mockClear();
        await start(new Request(`http://10.42.0.19:3100/api/attendee/oauth/google/start?next=${encodeURIComponent(next)}`));
        expect(mocks.cookieSet.mock.calls.some(([name]) => name === "imsda_attendee_oauth_next")).toBe(false);
      }
    });

    it("callback lands on the stored destination and clears the cookie", async () => {
      withNextCookie("/account/clubs/club-1/roster");
      const response = await callback(callbackRequest());
      expect(response.headers.get("location")).toBe("https://events.imsda.org/account/clubs/club-1/roster");
      expect(mocks.cookieSet).toHaveBeenCalledWith("imsda_attendee_oauth_next", "", expect.objectContaining({ maxAge: 0 }));
    });

    it("callback revalidates and falls back to /account for a tampered cookie", async () => {
      for (const bad of ["https://evil.example/", "//evil.example", "/account/%2e%2e/admin"]) {
        withNextCookie(bad);
        const response = await callback(callbackRequest());
        expect(response.headers.get("location")).toBe("https://events.imsda.org/account");
      }
    });
  });
});
