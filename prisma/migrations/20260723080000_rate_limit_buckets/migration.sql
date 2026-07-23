-- Durable fixed-window counters for anonymous and high-risk request paths.
-- `subjectHash` is a keyed digest; raw IP, email, user-agent, and bearer-token
-- values must never be written to this table.
CREATE TABLE "RateLimitBucket" (
  "id" TEXT NOT NULL,
  "policy" TEXT NOT NULL,
  "subjectHash" TEXT NOT NULL,
  "count" INTEGER NOT NULL,
  "windowStartedAt" TIMESTAMP(3) NOT NULL,
  "windowEndsAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RateLimitBucket_policy_subjectHash_windowStartedAt_key"
ON "RateLimitBucket"("policy", "subjectHash", "windowStartedAt");

-- Cleanup jobs can delete expired windows without scanning live buckets.
CREATE INDEX "RateLimitBucket_expiresAt_idx"
ON "RateLimitBucket"("expiresAt");

CREATE INDEX "RateLimitBucket_policy_windowEndsAt_idx"
ON "RateLimitBucket"("policy", "windowEndsAt");
