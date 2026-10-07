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
  publicManageBudgets,
  staffLoginBudgets,
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

describe("private manage-link budgets", () => {
  it("gives attendee QR images a larger client budget than other reads", async () => {
    const request = new Request("https://events.imsda.test/api/public/manage/token", {
      headers: { "x-forwarded-for": "192.0.2.10" },
    });

    await checkPublicManageRateLimit(request, "private-token", "read");
    await checkPublicManageRateLimit(request, "private-token", "pass");

    const [read, pass] = repositoryMocks.enforceRateLimitRules.mock.calls.map(
      ([rules]) => (rules as Array<{ policy: string; limit: number }>)
        .map(({ policy, limit }) => [policy, limit]),
    );
    expect(read).toEqual([
      ["public.manage.read.client", 600],
      ["public.manage.read.token", 120],
      ["public.manage.read.client-token", 60],
    ]);
    expect(pass).toEqual([
      ["public.manage.pass.client", 3000],
      ["public.manage.pass.token", 600],
      ["public.manage.pass.client-token", 300],
    ]);
  });
});

describe("check-in desk limiter sizes (#825)", () => {
  it("lets 4 devices sign one staff account in from one address, with a retry each", () => {
    expect(staffLoginBudgets.clientAccount).toBeGreaterThanOrEqual(4 * 2);
    expect(staffLoginBudgets.account).toBeGreaterThanOrEqual(staffLoginBudgets.clientAccount);
    expect(staffLoginBudgets.client).toBeGreaterThanOrEqual(staffLoginBudgets.account);
  });

  it("keeps sign-in guessing bounded per address and per account", () => {
    expect(staffLoginBudgets.clientAccount).toBeLessThanOrEqual(15);
    expect(staffLoginBudgets.account).toBeLessThanOrEqual(30);
  });

  it("sizes attendee pass budgets for a crowd behind one carrier address, but not per link", () => {
    expect(publicManageBudgets.pass.client).toBeGreaterThanOrEqual(500 * 3);
    expect(publicManageBudgets.read.client).toBeGreaterThanOrEqual(500);
    // One private link stays at a few loads a minute (15-minute window).
    // An announcement email embeds up to 8 attendee pass images per open (#824).
    expect(publicManageBudgets.pass.token).toBeGreaterThanOrEqual(8 * 60);
    expect(publicManageBudgets.pass.token / 15).toBeLessThanOrEqual(60);
    expect(publicManageBudgets.pass.clientToken).toBeLessThanOrEqual(publicManageBudgets.pass.token);
    expect(publicManageBudgets.update.client).toBeLessThanOrEqual(30);
  });

  it("charges no limiter on the authenticated scan, check-in, undo, live-list or staff pass routes", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of [
      "app/api/events/[eventId]/attendee-passes/resolve/route.ts",
      "app/api/events/[eventId]/attendees/[attendeeId]/check-in/route.ts",
      "app/api/events/[eventId]/attendee-passes/[attendeeId]/qr/route.ts",
      "app/api/events/[eventId]/check-ins/route.ts",
    ]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/rate-limit/);
    }
  });
});
