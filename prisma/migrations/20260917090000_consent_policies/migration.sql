CREATE TYPE "PolicyKind" AS ENUM ('CONSENT', 'WAIVER', 'ACKNOWLEDGMENT', 'APPROVAL_REQUIRED');
CREATE TYPE "PolicyScope" AS ENUM ('EVENT', 'ORGANIZATION');
CREATE TYPE "ConsentPolicyVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED');

CREATE TABLE "ConsentPolicy" (
    "id" TEXT NOT NULL,
    "eventId" TEXT,
    "kind" "PolicyKind" NOT NULL,
    "scope" "PolicyScope" NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currentVersionId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ConsentPolicy_pkey" PRIMARY KEY ("id"),
    -- Scope and ownership agree: event-scoped policies belong to one event,
    -- organization-scoped policies belong to none.
    CONSTRAINT "ConsentPolicy_scope_event_check" CHECK (
      ("scope" = 'EVENT' AND "eventId" IS NOT NULL)
      OR ("scope" = 'ORGANIZATION' AND "eventId" IS NULL)
    )
);

CREATE TABLE "ConsentPolicyVersion" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "publishedByUserId" TEXT,
    "versionNumber" INTEGER NOT NULL,
    "status" "ConsentPolicyVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "contentHash" TEXT,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveTo" TIMESTAMP(3),
    "isMaterialChange" BOOLEAN,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ConsentPolicyVersion_pkey" PRIMARY KEY ("id"),
    -- A published version always carries its publisher, timestamp, hash, and
    -- effective start; a draft carries none of them.
    CONSTRAINT "ConsentPolicyVersion_published_fields_check" CHECK (
      ("status" = 'PUBLISHED' AND "publishedAt" IS NOT NULL AND "publishedByUserId" IS NOT NULL
        AND "contentHash" IS NOT NULL AND "effectiveFrom" IS NOT NULL AND "isMaterialChange" IS NOT NULL)
      OR ("status" = 'DRAFT' AND "publishedAt" IS NULL AND "publishedByUserId" IS NULL
        AND "contentHash" IS NULL AND "effectiveFrom" IS NULL AND "effectiveTo" IS NULL
        AND "isMaterialChange" IS NULL)
    ),
    -- Effective windows are half-open [effectiveFrom, effectiveTo).
    CONSTRAINT "ConsentPolicyVersion_effective_window_check" CHECK (
      "effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom"
    )
);

CREATE TABLE "EventConsentPolicyApplicability" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "attendeeTypeDefinitionId" TEXT,
    "role" TEXT,
    "minimumAge" INTEGER,
    "maximumAge" INTEGER,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EventConsentPolicyApplicability_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EventConsentPolicyApplicability_age_band_check" CHECK (
      "minimumAge" IS NULL OR "maximumAge" IS NULL OR "minimumAge" <= "maximumAge"
    )
);

CREATE UNIQUE INDEX "ConsentPolicy_currentVersionId_key" ON "ConsentPolicy"("currentVersionId");
CREATE UNIQUE INDEX "ConsentPolicy_eventId_slug_key" ON "ConsentPolicy"("eventId", "slug");
CREATE INDEX "ConsentPolicy_scope_updatedAt_idx" ON "ConsentPolicy"("scope", "updatedAt");
-- Postgres treats NULL eventIds as distinct, so organization-scoped slugs need
-- their own partial unique index.
CREATE UNIQUE INDEX "ConsentPolicy_one_organization_slug" ON "ConsentPolicy"("slug") WHERE "eventId" IS NULL;

CREATE UNIQUE INDEX "ConsentPolicyVersion_policyId_versionNumber_key" ON "ConsentPolicyVersion"("policyId", "versionNumber");
CREATE INDEX "ConsentPolicyVersion_policyId_status_versionNumber_idx" ON "ConsentPolicyVersion"("policyId", "status", "versionNumber");
CREATE INDEX "ConsentPolicyVersion_policyId_effectiveFrom_effectiveTo_idx" ON "ConsentPolicyVersion"("policyId", "effectiveFrom", "effectiveTo");
-- At most one open draft per policy.
CREATE UNIQUE INDEX "ConsentPolicyVersion_one_draft_per_policy" ON "ConsentPolicyVersion"("policyId") WHERE "status" = 'DRAFT';

CREATE INDEX "EventConsentPolicyApplicability_eventId_isActive_idx" ON "EventConsentPolicyApplicability"("eventId", "isActive");
CREATE INDEX "EventConsentPolicyApplicability_policyId_idx" ON "EventConsentPolicyApplicability"("policyId");
CREATE INDEX "EventConsentPolicyApplicability_attendeeTypeDefinitionId_idx" ON "EventConsentPolicyApplicability"("attendeeTypeDefinitionId");

ALTER TABLE "ConsentPolicy" ADD CONSTRAINT "ConsentPolicy_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConsentPolicy" ADD CONSTRAINT "ConsentPolicy_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ConsentPolicy" ADD CONSTRAINT "ConsentPolicy_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "ConsentPolicyVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ConsentPolicyVersion" ADD CONSTRAINT "ConsentPolicyVersion_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "ConsentPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConsentPolicyVersion" ADD CONSTRAINT "ConsentPolicyVersion_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ConsentPolicyVersion" ADD CONSTRAINT "ConsentPolicyVersion_publishedByUserId_fkey" FOREIGN KEY ("publishedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EventConsentPolicyApplicability" ADD CONSTRAINT "EventConsentPolicyApplicability_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventConsentPolicyApplicability" ADD CONSTRAINT "EventConsentPolicyApplicability_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "ConsentPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventConsentPolicyApplicability" ADD CONSTRAINT "EventConsentPolicyApplicability_attendeeTypeDefinitionId_fkey" FOREIGN KEY ("attendeeTypeDefinitionId") REFERENCES "EventAttendeeType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Published versions are immutable. The repository only ever writes a draft
-- row, and this trigger rejects any UPDATE of a row that was already
-- published, so no code path — including a future one — can rewrite text a
-- person may have agreed to. A correction is a new version.
CREATE FUNCTION "reject_published_consent_policy_version_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" = 'PUBLISHED' THEN
    RAISE EXCEPTION 'published ConsentPolicyVersion rows are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ConsentPolicyVersion_published_immutable"
BEFORE UPDATE ON "ConsentPolicyVersion"
FOR EACH ROW
EXECUTE FUNCTION "reject_published_consent_policy_version_mutation"();

-- A policy's kind, scope, and owning event are fixed at creation: consent,
-- waiver, acknowledgment, and approval-required policies are never converted
-- into one another, because evidence already recorded against a version would
-- silently change meaning.
CREATE FUNCTION "reject_consent_policy_identity_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."scope" IS DISTINCT FROM OLD."scope"
    OR NEW."eventId" IS DISTINCT FROM OLD."eventId" THEN
    RAISE EXCEPTION 'ConsentPolicy kind, scope, and event are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ConsentPolicy_identity_immutable"
BEFORE UPDATE OF "kind", "scope", "eventId" ON "ConsentPolicy"
FOR EACH ROW
EXECUTE FUNCTION "reject_consent_policy_identity_mutation"();

-- The current-version pointer may only reference one of the policy's own
-- published versions.
CREATE OR REPLACE FUNCTION enforce_consent_policy_current_version() RETURNS trigger AS $$
BEGIN
  IF NEW."currentVersionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ConsentPolicyVersion" v
    WHERE v."id" = NEW."currentVersionId" AND v."policyId" = NEW."id" AND v."status" = 'PUBLISHED'
  ) THEN
    RAISE EXCEPTION 'current version must be a published version of this policy';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ConsentPolicy_current_version_guard"
BEFORE INSERT OR UPDATE OF "currentVersionId" ON "ConsentPolicy"
FOR EACH ROW EXECUTE FUNCTION enforce_consent_policy_current_version();

-- Cross-event references are rejected even when an ID exists: an event's
-- applicability can only reference an organization-scoped policy or one of
-- its own event-scoped policies, and only its own attendee types.
CREATE OR REPLACE FUNCTION enforce_consent_policy_applicability_event() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "ConsentPolicy" p
    WHERE p."id" = NEW."policyId" AND (p."eventId" IS NULL OR p."eventId" = NEW."eventId")
  ) THEN
    RAISE EXCEPTION 'policy belongs to another event';
  END IF;
  IF NEW."attendeeTypeDefinitionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "EventAttendeeType" t WHERE t."id" = NEW."attendeeTypeDefinitionId" AND t."eventId" = NEW."eventId"
  ) THEN
    RAISE EXCEPTION 'attendee type belongs to another event';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EventConsentPolicyApplicability_event_guard"
BEFORE INSERT OR UPDATE OF "eventId", "policyId", "attendeeTypeDefinitionId" ON "EventConsentPolicyApplicability"
FOR EACH ROW EXECUTE FUNCTION enforce_consent_policy_applicability_event();
