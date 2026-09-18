-- Identity slice 2 (#126): duplicate match candidates, evidence, and the
-- staff review queue.
--
-- This migration is purely additive: one new table plus three new enums.
-- Nothing existing is touched, and no code path anywhere applies a
-- candidate automatically — candidates are generated evidence, reviewed by
-- a human, and (for now) can only be dismissed or left open. Merging is
-- slice 3 (#127) and does not exist yet.

CREATE TYPE "PersonMatchSignal" AS ENUM (
  'EMAIL_MATCH',
  'PHONE_MATCH',
  'SAME_SURNAME',
  'SAME_FULL_NAME',
  'HOUSEHOLD_SHARED',
  'EXTERNAL_IDENTITY_SHARED',
  'EMAIL_MISMATCH',
  'PHONE_MISMATCH'
);

CREATE TYPE "PersonMatchConfidence" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

CREATE TYPE "PersonMatchState" AS ENUM ('OPEN', 'DISMISSED', 'SUPERSEDED', 'MERGED');

CREATE TABLE "PersonMatchCandidate" (
    "id" TEXT NOT NULL,
    "personAId" TEXT NOT NULL,
    "personBId" TEXT NOT NULL,
    "matchedSignals" "PersonMatchSignal"[] NOT NULL DEFAULT ARRAY[]::"PersonMatchSignal"[],
    "contradictingSignals" "PersonMatchSignal"[] NOT NULL DEFAULT ARRAY[]::"PersonMatchSignal"[],
    "confidence" "PersonMatchConfidence" NOT NULL,
    "ruleVersion" INTEGER NOT NULL,
    "state" "PersonMatchState" NOT NULL DEFAULT 'OPEN',
    "fingerprint" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissedAt" TIMESTAMP(3),
    "dismissedByUserId" TEXT,
    "dismissalReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PersonMatchCandidate_pkey" PRIMARY KEY ("id"),
    -- Canonical pair ordering: the two person ids are always stored with
    -- personAId < personBId, so the pair itself (not an ordered tuple) is
    -- what the unique index below reasons about. Enforced here because
    -- Prisma has no way to express this in the schema itself.
    CONSTRAINT "PersonMatchCandidate_ordered_pair_check" CHECK ("personAId" < "personBId"),
    -- A dismissal always carries its reason and actor together, and only a
    -- dismissed row carries them at all.
    CONSTRAINT "PersonMatchCandidate_dismissal_check" CHECK (
      ("state" = 'DISMISSED' AND "dismissedAt" IS NOT NULL AND "dismissedByUserId" IS NOT NULL AND "dismissalReason" IS NOT NULL)
      OR ("state" != 'DISMISSED' AND "dismissedAt" IS NULL AND "dismissedByUserId" IS NULL AND "dismissalReason" IS NULL)
    )
);

-- Makes candidate generation idempotent (a rerun over unchanged data
-- recomputes the same fingerprint for the same pair and finds this row
-- instead of inserting a duplicate) and lets a dismissed pair stay
-- suppressed until its fingerprint actually changes. See the model doc in
-- prisma/schema.prisma.
CREATE UNIQUE INDEX "PersonMatchCandidate_personAId_personBId_fingerprint_key" ON "PersonMatchCandidate"("personAId", "personBId", "fingerprint");
CREATE INDEX "PersonMatchCandidate_personAId_idx" ON "PersonMatchCandidate"("personAId");
CREATE INDEX "PersonMatchCandidate_personBId_idx" ON "PersonMatchCandidate"("personBId");
CREATE INDEX "PersonMatchCandidate_state_idx" ON "PersonMatchCandidate"("state");

ALTER TABLE "PersonMatchCandidate" ADD CONSTRAINT "PersonMatchCandidate_personAId_fkey" FOREIGN KEY ("personAId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PersonMatchCandidate" ADD CONSTRAINT "PersonMatchCandidate_personBId_fkey" FOREIGN KEY ("personBId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PersonMatchCandidate" ADD CONSTRAINT "PersonMatchCandidate_dismissedByUserId_fkey" FOREIGN KEY ("dismissedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
