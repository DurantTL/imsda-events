import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const repositoryMocks = vi.hoisted(() => ({
  enforceRateLimitRules: vi.fn(),
}));

vi.mock("@/modules/rate-limit/repository", () => repositoryMocks);

import {
  checkLoginAccountRateLimit,
  checkPublicManageRateLimit,
  checkRegistrationCodeAccessRateLimit,
  checkRegistrationRecoveryRateLimit,
} from "@/modules/rate-limit/service";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv(
    "RATE_LIMIT_HASH_SECRET",
    "test-only-rate-limit-secret-with-at-least-32-characters",
  );
  vi.stubEnv("RATE_LIMIT_TRUSTED_PROXY_HOPS", "1");
  vi.stubEnv("RATE_LIMIT_CLIENT_IP_HEADER", "x-forwarded-for");
  repositoryMocks.enforceRateLimitRules.mockResolvedValue({
    allowed: true,
    decisions: [],
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("rate-limit subject privacy", () => {
  it("passes only policy metadata and HMAC digests to the persistence layer", async () => {
    const rawEmail = "Private.Person+imsda@example.test";
    const rawToken = "private-registration-token-do-not-store";
    const rawIp = "192.0.2.83";
    const rawUserAgent = "Private Browser Fingerprint/9.7";
    const request = new Request(
      `https://events.imsda.test/api/public/manage/${rawToken}`,
      {
        headers: {
          "x-forwarded-for": rawIp,
          "user-agent": rawUserAgent,
        },
      },
    );

    await checkLoginAccountRateLimit(request, rawEmail);
    await checkPublicManageRateLimit(request, rawToken, "update");
    await checkRegistrationCodeAccessRateLimit(request, {
      confirmationCode: "REG-PRIVATE",
      email: rawEmail,
    });
    await checkRegistrationRecoveryRateLimit(request, rawEmail);

    const batches = repositoryMocks.enforceRateLimitRules.mock.calls.map(
      ([rules]) => rules as Array<{
        policy: string;
        subjectHash: string;
        limit: number;
        windowSeconds: number;
      }>,
    );
    const rules = batches.flat();
    const serializedRules = JSON.stringify(rules);

    expect(rules).toHaveLength(15);
    expect(rules.map((entry) => entry.policy)).toEqual([
      "auth.login.account",
      "auth.login.client-account",
      "public.manage.update.client",
      "public.manage.update.token",
      "public.manage.update.client-token",
      "registration.code-access.client",
      "registration.code-access.email",
      "registration.code-access.code",
      "registration.code-access.pair",
      "registration.code-access.client-email",
      "registration.code-access.client-code",
      "registration.code-access.client-pair",
      "registration.recovery.client",
      "registration.recovery.subject",
      "registration.recovery.client-subject",
    ]);
    expect(rules.every((entry) => /^[a-f0-9]{64}$/.test(entry.subjectHash)))
      .toBe(true);
    expect(serializedRules).not.toContain(rawEmail);
    expect(serializedRules).not.toContain(rawEmail.toLowerCase());
    expect(serializedRules).not.toContain(rawToken);
    expect(serializedRules).not.toContain("REG-PRIVATE");
    expect(serializedRules).not.toContain(rawIp);
    expect(serializedRules).not.toContain(rawUserAgent);
  });
});
