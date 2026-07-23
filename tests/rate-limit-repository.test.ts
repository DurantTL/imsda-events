import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  consumeRateLimitRule,
  deleteExpiredRateLimitBuckets,
  enforceRateLimitRules,
} from "@/modules/rate-limit/repository";

function atomicBucketClient() {
  const counts = new Map<string, number>();
  const deleteMany = vi.fn(async () => ({ count: 0 }));
  const query = vi.fn(async (statement: { values: unknown[] }) => {
    const policy = String(statement.values[1]);
    const subjectHash = String(statement.values[2]);
    const windowStartedAt = statement.values[3] as Date;
    const windowEndsAt = statement.values[4] as Date;
    const key = `${policy}:${subjectHash}:${windowStartedAt.toISOString()}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return [{ count, windowEndsAt }];
  });
  return {
    client: {
      $queryRaw: query,
      rateLimitBucket: { deleteMany },
    },
    counts,
    deleteMany,
    query,
  };
}

const rule = {
  policy: "test.concurrent",
  subjectHash: "a".repeat(64),
  limit: 5,
  windowSeconds: 60,
};

describe("atomic database rate-limit buckets", () => {
  it("allows exactly the configured number under concurrent consumption", async () => {
    const { client } = atomicBucketClient();
    const decisions = await Promise.all(
      Array.from({ length: 20 }, () => consumeRateLimitRule(rule, {
        client: client as never,
        now: new Date("2026-07-23T12:00:10.000Z"),
      })),
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(5);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(15);
    expect(decisions.map((decision) => decision.count).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it("starts a fresh counter at the next fixed window boundary", async () => {
    const { client, query } = atomicBucketClient();
    const first = await consumeRateLimitRule({
      ...rule,
      limit: 1,
    }, {
      client: client as never,
      now: new Date("2026-07-23T12:00:59.500Z"),
    });
    const denied = await consumeRateLimitRule({
      ...rule,
      limit: 1,
    }, {
      client: client as never,
      now: new Date("2026-07-23T12:00:59.900Z"),
    });
    const reset = await consumeRateLimitRule({
      ...rule,
      limit: 1,
    }, {
      client: client as never,
      now: new Date("2026-07-23T12:01:00.000Z"),
    });

    expect(first).toMatchObject({ allowed: true, count: 1, remaining: 0 });
    expect(denied).toMatchObject({ allowed: false, count: 2, remaining: 0 });
    expect(reset).toMatchObject({ allowed: true, count: 1, remaining: 0 });
    expect((query.mock.calls[0][0] as { values: unknown[] }).values[3])
      .toEqual(new Date("2026-07-23T12:00:00.000Z"));
    expect((query.mock.calls[2][0] as { values: unknown[] }).values[3])
      .toEqual(new Date("2026-07-23T12:01:00.000Z"));
  });

  it("denies the aggregate outcome when any independent bucket is exhausted", async () => {
    const { client } = atomicBucketClient();
    const rules = [
      {
        policy: "test.client",
        subjectHash: "b".repeat(64),
        limit: 10,
        windowSeconds: 900,
      },
      {
        policy: "test.account",
        subjectHash: "c".repeat(64),
        limit: 1,
        windowSeconds: 900,
      },
    ];

    await enforceRateLimitRules(rules, {
      client: client as never,
      now: new Date("2026-07-23T12:00:00.000Z"),
    });
    const second = await enforceRateLimitRules(rules, {
      client: client as never,
      now: new Date("2026-07-23T12:00:01.000Z"),
    });

    expect(second.allowed).toBe(false);
    expect(second.decisions).toEqual([
      expect.objectContaining({ policy: "test.client", allowed: true }),
      expect.objectContaining({ policy: "test.account", allowed: false }),
    ]);
  });

  it("deletes only buckets whose retention expiry has passed", async () => {
    const { client, deleteMany } = atomicBucketClient();
    const now = new Date("2026-07-23T12:00:00.000Z");

    await deleteExpiredRateLimitBuckets(now, client as never);

    expect(deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lte: now } },
    });
  });
});
