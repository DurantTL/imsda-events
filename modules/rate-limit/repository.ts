import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import type {
  RateLimitDecision,
  RateLimitOutcome,
} from "@/modules/rate-limit/domain";

type RateLimitClient = Prisma.TransactionClient | PrismaClient;

export type RateLimitRule = {
  policy: string;
  subjectHash: string;
  limit: number;
  windowSeconds: number;
};

type IncrementedBucket = {
  count: number;
  windowEndsAt: Date;
};

const cleanupRetentionSeconds = 24 * 60 * 60;
const cleanupIntervalMilliseconds = 15 * 60 * 1_000;
const cleanupRetryMilliseconds = 60 * 1_000;
const nextCleanupAtByClient = new WeakMap<object, number>();

function assertRule(rule: RateLimitRule) {
  if (!/^[a-z0-9_.-]{1,100}$/.test(rule.policy)) {
    throw new RangeError("A rate-limit policy must use a stable safe identifier.");
  }
  if (!/^[a-f0-9]{64}$/.test(rule.subjectHash)) {
    throw new RangeError("A rate-limit subject must be a 256-bit hexadecimal digest.");
  }
  if (!Number.isInteger(rule.limit) || rule.limit < 1 || rule.limit > 1_000_000) {
    throw new RangeError("A rate-limit rule requires a positive whole-number limit.");
  }
  if (
    !Number.isInteger(rule.windowSeconds)
    || rule.windowSeconds < 1
    || rule.windowSeconds > 7 * 24 * 60 * 60
  ) {
    throw new RangeError("A rate-limit window must be between one second and seven days.");
  }
}

export async function consumeRateLimitRule(
  rule: RateLimitRule,
  options: { now?: Date; client?: RateLimitClient } = {},
): Promise<RateLimitDecision> {
  assertRule(rule);
  const now = options.now ?? new Date();
  if (Number.isNaN(now.valueOf())) {
    throw new RangeError("A valid rate-limit evaluation time is required.");
  }
  const client = options.client ?? getPrisma();
  const windowMilliseconds = rule.windowSeconds * 1_000;
  const windowStartedAt = new Date(
    Math.floor(now.getTime() / windowMilliseconds) * windowMilliseconds,
  );
  const windowEndsAt = new Date(
    windowStartedAt.getTime() + windowMilliseconds,
  );
  const expiresAt = new Date(
    windowEndsAt.getTime() + cleanupRetentionSeconds * 1_000,
  );

  // PostgreSQL performs the increment while holding the unique-key conflict
  // lock, so simultaneous application instances cannot each observe an
  // allowed stale count.
  const rows = await client.$queryRaw<IncrementedBucket[]>(Prisma.sql`
    INSERT INTO "RateLimitBucket" (
      "id",
      "policy",
      "subjectHash",
      "count",
      "windowStartedAt",
      "windowEndsAt",
      "expiresAt",
      "createdAt",
      "updatedAt"
    )
    VALUES (
      ${randomUUID()},
      ${rule.policy},
      ${rule.subjectHash},
      1,
      ${windowStartedAt},
      ${windowEndsAt},
      ${expiresAt},
      ${now},
      ${now}
    )
    ON CONFLICT ("policy", "subjectHash", "windowStartedAt")
    DO UPDATE SET
      "count" = "RateLimitBucket"."count" + 1,
      "windowEndsAt" = EXCLUDED."windowEndsAt",
      "expiresAt" = EXCLUDED."expiresAt",
      "updatedAt" = EXCLUDED."updatedAt"
    RETURNING "count", "windowEndsAt"
  `);
  const bucket = rows[0];
  if (!bucket) throw new Error("The rate-limit bucket could not be incremented.");
  const count = Number(bucket.count);
  const allowed = count <= rule.limit;

  return {
    policy: rule.policy,
    allowed,
    limit: rule.limit,
    remaining: Math.max(rule.limit - count, 0),
    count,
    windowSeconds: rule.windowSeconds,
    resetAfterSeconds: Math.max(
      1,
      Math.ceil((bucket.windowEndsAt.getTime() - now.getTime()) / 1_000),
    ),
  };
}

export async function enforceRateLimitRules(
  rules: readonly RateLimitRule[],
  options: { now?: Date; client?: RateLimitClient } = {},
): Promise<RateLimitOutcome> {
  const now = options.now ?? new Date();
  const client = options.client ?? getPrisma();
  await deleteExpiredRateLimitBucketsIfDue(now, client);
  const decisions = await Promise.all(
    rules.map((rule) => consumeRateLimitRule(rule, { now, client })),
  );
  return {
    allowed: decisions.every((decision) => decision.allowed),
    decisions,
  };
}

export async function deleteExpiredRateLimitBuckets(
  now = new Date(),
  client: RateLimitClient = getPrisma(),
) {
  return client.rateLimitBucket.deleteMany({
    where: { expiresAt: { lte: now } },
  });
}

async function deleteExpiredRateLimitBucketsIfDue(
  now: Date,
  client: RateLimitClient,
) {
  const clientKey = client as object;
  if ((nextCleanupAtByClient.get(clientKey) ?? 0) > now.getTime()) return;

  // Mark the cleanup before awaiting it so concurrent requests on one
  // application instance do not all start the same indexed delete.
  nextCleanupAtByClient.set(
    clientKey,
    now.getTime() + cleanupIntervalMilliseconds,
  );
  try {
    await deleteExpiredRateLimitBuckets(now, client);
  } catch (error) {
    // Cleanup must not turn an otherwise enforceable security decision into
    // an outage. Retry soon and expose no request identifier in the log.
    nextCleanupAtByClient.set(
      clientKey,
      now.getTime() + cleanupRetryMilliseconds,
    );
    console.error(
      "Expired rate-limit bucket cleanup failed.",
      error instanceof Error ? error.name : "UnknownError",
    );
  }
}
