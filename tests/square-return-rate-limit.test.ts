import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/request-context", () => ({ withRequestContext: (handler: unknown) => handler }));

// A real counting limiter in place of the database: every rule keeps its own count per policy and
// subject, and a request is allowed only while every rule is within its limit.
const limiter = vi.hoisted(() => {
  const counts = new Map<string, number>();
  return {
    counts,
    enforceRateLimitRules: vi.fn(async (rules: Array<{
      policy: string;
      subjectHash: string;
      limit: number;
      windowSeconds: number;
    }>) => {
      const decisions = rules.map((rule) => {
        const key = `${rule.policy}:${rule.subjectHash}`;
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return {
          policy: rule.policy,
          allowed: count <= rule.limit,
          limit: rule.limit,
          remaining: Math.max(rule.limit - count, 0),
          count,
          windowSeconds: rule.windowSeconds,
          resetAfterSeconds: rule.windowSeconds,
        };
      });
      return { allowed: decisions.every((decision) => decision.allowed), decisions };
    }),
  };
});
vi.mock("@/modules/rate-limit/repository", () => ({ enforceRateLimitRules: limiter.enforceRateLimitRules }));

const status = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/modules/payments/square-hosted-return", () => ({ getHostedReturnStatus: status.get }));

import {
  checkPublicPaymentRateLimit,
  checkPublicPaymentStatusRateLimit,
  publicPaymentStatusBudgets,
} from "@/modules/rate-limit/service";
import { GET } from "@/app/api/public/square-return/[returnId]/route";
import {
  hostedReturnPollIntervalMs,
  nextHostedReturnDelay,
  startHostedReturnPolling,
} from "@/modules/payments/hosted-return-polling";

type Handler = (request: Request, context: unknown) => Promise<Response>;
const get = GET as unknown as Handler;
const returnId = "R".repeat(43);
const otherId = "S".repeat(43);

function request(ip = "192.0.2.10") {
  return new Request(`https://events.imsda.test/api/public/square-return/${returnId}`, {
    headers: { "x-forwarded-for": ip },
  });
}
const context = (id = returnId) => ({ params: Promise.resolve({ returnId: id }) });

beforeEach(() => {
  limiter.counts.clear();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("RATE_LIMIT_HASH_SECRET", "test-only-rate-limit-secret-with-at-least-32-characters");
  vi.stubEnv("RATE_LIMIT_TRUSTED_PROXY_HOPS", "1");
  vi.stubEnv("RATE_LIMIT_CLIENT_IP_HEADER", "x-forwarded-for");
  status.get.mockResolvedValue({ state: "CONFIRMING", maskedConfirmationCode: "••••4417" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("the return status poll's own rate limit (#327)", () => {
  it("allows a page's polling many times over and then answers 429 for that client and id", async () => {
    for (let poll = 0; poll < publicPaymentStatusBudgets.clientId; poll += 1) {
      expect((await get(request(), context())).status).toBe(200);
    }
    const limited = await get(request(), context());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toContain("no-store");
    // Another id from the same client still has the client-wide budget.
    expect((await get(request(), context(otherId))).status).toBe(200);
    // Another client is not affected.
    expect((await get(request("192.0.2.99"), context())).status).toBe(200);
  });

  it("never spends the payment-writing buckets, and they never spend its own", async () => {
    for (let poll = 0; poll < publicPaymentStatusBudgets.clientId; poll += 1) {
      await checkPublicPaymentStatusRateLimit(request(), returnId);
    }
    const payment = await checkPublicPaymentRateLimit(request(), "a".repeat(43));
    expect(payment.allowed).toBe(true);
    expect(payment.decisions.every((decision) => decision.count === 1)).toBe(true);
    for (let attempt = 0; attempt < 5; attempt += 1) await checkPublicPaymentRateLimit(request(), "b".repeat(43));
    const stillPolling = await checkPublicPaymentStatusRateLimit(request(), otherId);
    expect(stillPolling.allowed).toBe(true);
    const names = limiter.enforceRateLimitRules.mock.calls.flatMap(([rules]) => rules.map((rule) => rule.policy));
    expect(names).toContain("public.payment-status.client-id");
    expect(names).toContain("public.payment.client-token");
  });
});

describe("the pollers keep going when throttled (#327)", () => {
  it("backs off on 429 or failure, resets on an answer, and caps the delay", () => {
    expect(nextHostedReturnDelay(hostedReturnPollIntervalMs, "THROTTLED_OR_FAILED")).toBe(10_000);
    expect(nextHostedReturnDelay(40_000, "THROTTLED_OR_FAILED")).toBe(60_000);
    expect(nextHostedReturnDelay(60_000, "THROTTLED_OR_FAILED")).toBe(60_000);
    expect(nextHostedReturnDelay(60_000, "ANSWERED")).toBe(hostedReturnPollIntervalMs);
  });

  it("treats a 429 as keep polling, slower, and stops on a settled state", async () => {
    vi.useFakeTimers();
    const answers = [
      new Response("{}", { status: 429 }),
      new Response("{}", { status: 429 }),
      Response.json({ state: "CONFIRMING", maskedConfirmationCode: "••••4417" }),
      Response.json({ state: "CONFIRMED", maskedConfirmationCode: "••••4417" }),
    ];
    const fetcher = vi.fn(async () => answers.shift()!) as unknown as typeof fetch;
    const seen: string[] = [];
    const stop = startHostedReturnPolling(returnId, (next) => { seen.push(next.state); }, { immediate: true, fetcher });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(seen).toEqual(["CONFIRMING"]);
    await vi.advanceTimersByTimeAsync(hostedReturnPollIntervalMs);
    expect(seen).toEqual(["CONFIRMING", "CONFIRMED"]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetcher).toHaveBeenCalledTimes(4);
    stop();
  });
});
