-- Identity slice 1 (#125): account-to-person links and time-bounded
-- household membership.
--
-- This migration is additive and does not backfill existing data. The new
-- HouseholdMember.effectiveFrom / effectiveTo columns are nullable so
-- existing rows are unaffected on deploy; a legacy row with a null
-- effectiveFrom is treated as "always active from before recorded history"
-- by point-in-time resolution (modules/people/household-repository.ts).
-- Populating effectiveFrom from createdAt for those legacy rows is a
-- separate, operator-invoked, idempotent step with a dry-run mode
-- (`npm run household-membership:backfill`, see
-- modules/people/household-backfill.ts and
-- scripts/backfill-household-membership-effective-dates.ts) rather than part
-- of this migration, so a human keeps the checkpoint AGENTS.md requires for
-- changes to existing data.

CREATE TYPE "PersonLinkProvenance" AS ENUM ('SELF_SERVICE_VERIFICATION', 'STAFF_ACTION', 'IMPORT');

-- Needed for the GIST exclusion constraint below, which uses plain equality
-- (=) operators on text columns alongside the range overlap operator.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE "AttendeeAccountPersonLink" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "provenance" "PersonLinkProvenance" NOT NULL,
    "actorAttendeeAccountId" TEXT,
    "actorUserId" TEXT,
    "evidenceReference" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AttendeeAccountPersonLink_pkey" PRIMARY KEY ("id"),
    -- Provenance and actor agree: a self-service link is actored by the
    -- account itself and never a staff user; a staff-action or import link
    -- is actored by a staff user and never the account. Mirrors the
    -- StaffNote single-subject check's XOR shape.
    CONSTRAINT "AttendeeAccountPersonLink_actor_check" CHECK (
      ("provenance" = 'SELF_SERVICE_VERIFICATION' AND "actorAttendeeAccountId" IS NOT NULL AND "actorUserId" IS NULL)
      OR ("provenance" IN ('STAFF_ACTION', 'IMPORT') AND "actorUserId" IS NOT NULL AND "actorAttendeeAccountId" IS NULL)
    ),
    CONSTRAINT "AttendeeAccountPersonLink_evidence_reference_check" CHECK (btrim("evidenceReference") <> '')
);

CREATE TABLE "UserPersonLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "provenance" "PersonLinkProvenance" NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "evidenceReference" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserPersonLink_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UserPersonLink_evidence_reference_check" CHECK (btrim("evidenceReference") <> '')
);

CREATE UNIQUE INDEX "AttendeeAccountPersonLink_accountId_key" ON "AttendeeAccountPersonLink"("accountId");
CREATE INDEX "AttendeeAccountPersonLink_personId_idx" ON "AttendeeAccountPersonLink"("personId");

CREATE UNIQUE INDEX "UserPersonLink_userId_key" ON "UserPersonLink"("userId");
CREATE INDEX "UserPersonLink_personId_idx" ON "UserPersonLink"("personId");

ALTER TABLE "AttendeeAccountPersonLink" ADD CONSTRAINT "AttendeeAccountPersonLink_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AttendeeAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttendeeAccountPersonLink" ADD CONSTRAINT "AttendeeAccountPersonLink_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttendeeAccountPersonLink" ADD CONSTRAINT "AttendeeAccountPersonLink_actorAttendeeAccountId_fkey" FOREIGN KEY ("actorAttendeeAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AttendeeAccountPersonLink" ADD CONSTRAINT "AttendeeAccountPersonLink_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "UserPersonLink" ADD CONSTRAINT "UserPersonLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserPersonLink" ADD CONSTRAINT "UserPersonLink_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserPersonLink" ADD CONSTRAINT "UserPersonLink_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Time-bounded household membership. Both columns are nullable on arrival:
-- effectiveTo null means "still a member"; effectiveFrom null marks a
-- legacy row that predates this migration and has not yet run through the
-- backfill script (see the header note above).
ALTER TABLE "HouseholdMember" ADD COLUMN "effectiveFrom" TIMESTAMP(3);
ALTER TABLE "HouseholdMember" ADD COLUMN "effectiveTo" TIMESTAMP(3);

ALTER TABLE "HouseholdMember" ADD CONSTRAINT "HouseholdMember_effective_range_check" CHECK (
  "effectiveFrom" IS NULL OR "effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom"
);

-- A person could previously only ever have one row per household because
-- HouseholdMember_householdId_personId_key made re-joining impossible. That
-- uniqueness is replaced by the exclusion constraint below, which allows a
-- person to leave and later rejoin the same household (as separate,
-- non-overlapping rows) while still preventing two open-ended or otherwise
-- overlapping memberships of the same person in the same household. A plain
-- index keeps the common household+person lookups fast.
DROP INDEX "HouseholdMember_householdId_personId_key";
CREATE INDEX "HouseholdMember_householdId_personId_idx" ON "HouseholdMember"("householdId", "personId");

-- A NULL effectiveTo behaves as +infinity and a NULL effectiveFrom behaves
-- as -infinity in a tsrange constructed this way, which is exactly the
-- semantics an open-ended or not-yet-backfilled row needs.
ALTER TABLE "HouseholdMember" ADD CONSTRAINT "HouseholdMember_no_overlapping_membership" EXCLUDE USING gist (
  "personId" WITH =,
  "householdId" WITH =,
  tsrange("effectiveFrom", "effectiveTo") WITH &&
);
