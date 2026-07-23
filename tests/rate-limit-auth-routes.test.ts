import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  authenticateWithPassword: vi.fn(),
  issuePasswordReset: vi.fn(),
}));

const rateLimitMocks = vi.hoisted(() => ({
  checkLoginAccountRateLimit: vi.fn(),
  checkLoginClientRateLimit: vi.fn(),
  checkPasswordResetAccountRateLimit: vi.fn(),
  checkPasswordResetClientRateLimit: vi.fn(),
}));

vi.mock("@/modules/access/auth-service", () => authMocks);
vi.mock("@/modules/access/session-store", () => ({
  SESSION_COOKIE_NAME: "imsda_session",
  SESSION_LIFETIME_SECONDS: 28_800,
}));
vi.mock("@/modules/rate-limit/service", () => rateLimitMocks);

import { POST as login } from "@/app/api/auth/login/route";
import { POST as requestPasswordReset } from "@/app/api/auth/password-reset/request/route";

function rateLimitOutcome(
  policy: string,
  allowed: boolean,
  resetAfterSeconds = 417,
) {
  return {
    allowed,
    decisions: [{
      policy,
      allowed,
      limit: 5,
      remaining: allowed ? 4 : 0,
      count: allowed ? 1 : 6,
      windowSeconds: 900,
      resetAfterSeconds,
    }],
  };
}

function post(path: string, body: unknown) {
  return new Request(`https://events.imsda.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://events.imsda.test",
      "user-agent": "rate-limit-route-test",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  rateLimitMocks.checkLoginClientRateLimit.mockResolvedValue(
    rateLimitOutcome("auth.login.client", true),
  );
  rateLimitMocks.checkLoginAccountRateLimit.mockResolvedValue(
    rateLimitOutcome("auth.login.account", true),
  );
  rateLimitMocks.checkPasswordResetClientRateLimit.mockResolvedValue(
    rateLimitOutcome("auth.password-reset.client", true),
  );
  rateLimitMocks.checkPasswordResetAccountRateLimit.mockResolvedValue(
    rateLimitOutcome("auth.password-reset.account", true),
  );
  authMocks.authenticateWithPassword.mockResolvedValue(null);
  authMocks.issuePasswordReset.mockResolvedValue(null);
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("authentication route rate limiting", () => {
  it("rejects an exhausted login client bucket before reading credentials", async () => {
    rateLimitMocks.checkLoginClientRateLimit.mockResolvedValue(
      rateLimitOutcome("auth.login.client", false),
    );

    const response = await login(post("/api/auth/login", {
      email: "staff@imsda.test",
      password: "correct horse battery staple",
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("417");
    expect(response.headers.get("ratelimit-remaining")).toBe("0");
    expect(rateLimitMocks.checkLoginAccountRateLimit).not.toHaveBeenCalled();
    expect(authMocks.authenticateWithPassword).not.toHaveBeenCalled();
  });

  it("enforces the email and client-email buckets after normalizing valid input", async () => {
    rateLimitMocks.checkLoginAccountRateLimit.mockResolvedValue(
      rateLimitOutcome("auth.login.client-account", false, 333),
    );

    const response = await login(post("/api/auth/login", {
      email: " STAFF@IMSDA.TEST ",
      password: "incorrect",
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("333");
    expect(rateLimitMocks.checkLoginAccountRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      "STAFF@IMSDA.TEST",
    );
    expect(authMocks.authenticateWithPassword).not.toHaveBeenCalled();
  });

  it("keeps rate-limit headers on an ordinary invalid-credentials response", async () => {
    const response = await login(post("/api/auth/login", {
      email: "staff@imsda.test",
      password: "incorrect",
    }));

    expect(response.status).toBe(401);
    expect(response.headers.get("ratelimit-limit")).toBe("5");
    expect(response.headers.get("ratelimit-remaining")).toBe("4");
    expect(response.headers.has("retry-after")).toBe(false);
    expect(authMocks.authenticateWithPassword).toHaveBeenCalledOnce();
  });
});

describe("password-reset enumeration safety", () => {
  it("returns the generic success response when the client bucket is exhausted", async () => {
    rateLimitMocks.checkPasswordResetClientRateLimit.mockResolvedValue(
      rateLimitOutcome("auth.password-reset.client", false),
    );

    const response = await requestPasswordReset(post(
      "/api/auth/password-reset/request",
      { email: "staff@imsda.test" },
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("retry-after")).toBe("417");
    expect(await response.json()).toEqual({
      ok: true,
      message: "If that account exists, password reset instructions are ready.",
    });
    expect(rateLimitMocks.checkPasswordResetAccountRateLimit).not.toHaveBeenCalled();
    expect(authMocks.issuePasswordReset).not.toHaveBeenCalled();
  });

  it("does not reveal whether an account bucket or a nonexistent account produced no reset", async () => {
    const accountLimited = post("/api/auth/password-reset/request", {
      email: "staff@imsda.test",
    });
    rateLimitMocks.checkPasswordResetAccountRateLimit.mockResolvedValueOnce(
      rateLimitOutcome("auth.password-reset.account", false),
    );
    const limitedResponse = await requestPasswordReset(accountLimited);
    const limitedBody = await limitedResponse.json();

    const nonexistentResponse = await requestPasswordReset(post(
      "/api/auth/password-reset/request",
      { email: "nobody@imsda.test" },
    ));
    const nonexistentBody = await nonexistentResponse.json();

    expect(limitedResponse.status).toBe(200);
    expect(nonexistentResponse.status).toBe(200);
    expect(limitedBody).toEqual(nonexistentBody);
    expect(limitedBody).not.toHaveProperty("resetUrl");
    expect(authMocks.issuePasswordReset).toHaveBeenCalledTimes(1);
    expect(authMocks.issuePasswordReset).toHaveBeenCalledWith(
      "nobody@imsda.test",
    );
  });
});
