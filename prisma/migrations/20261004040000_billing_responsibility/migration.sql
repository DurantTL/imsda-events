-- #165 slice 1: organization billing contacts, per-registration billing responsibility with
-- append-only history, and the per-event invoice grouping setting. Additive only: new enums,
-- one new Event column with a default, and three new tables. Nothing existing is changed or deleted.
-- CreateEnum
CREATE TYPE "InvoiceGrouping" AS ENUM ('PER_CHURCH', 'PER_CLUB');

-- CreateEnum
CREATE TYPE "BillingContactSource" AS ENUM ('STAFF_ENTERED');

-- CreateEnum
CREATE TYPE "BillingResponsibleKind" AS ENUM ('ORGANIZATION', 'PERSON', 'UNRESOLVED');

-- CreateEnum
CREATE TYPE "BillingResponsibilitySource" AS ENUM ('CLUB_SPONSORING_CHURCH', 'GROUP_BILLING_PERSON', 'UNRESOLVED_CLUB_HAS_NO_CHURCH', 'UNRESOLVED_NO_ORGANIZATION_LINKED', 'STAFF_LINKED', 'STAFF_OVERRIDE');

-- CreateEnum
CREATE TYPE "BillingResponsibilityChangeType" AS ENUM ('RESOLVED', 'RE_RESOLVED', 'STAFF_LINKED', 'STAFF_OVERRIDE', 'OVERRIDE_CLEARED');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "invoiceGrouping" "InvoiceGrouping" NOT NULL DEFAULT 'PER_CHURCH';

-- CreateTable
CREATE TABLE "OrganizationBillingContact" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "roleLabel" TEXT NOT NULL,
    "source" "BillingContactSource" NOT NULL DEFAULT 'STAFF_ENTERED',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "verifiedByUserId" TEXT,
    "createdByUserId" TEXT,
    "endedByUserId" TEXT,
    "endReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationBillingContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistrationBillingResponsibility" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "kind" "BillingResponsibleKind" NOT NULL,
    "organizationId" TEXT,
    "personId" TEXT,
    "source" "BillingResponsibilitySource" NOT NULL,
    "reason" TEXT,
    "setByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegistrationBillingResponsibility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistrationBillingResponsibilityChange" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "changeType" "BillingResponsibilityChangeType" NOT NULL,
    "fromKind" "BillingResponsibleKind",
    "fromOrganizationId" TEXT,
    "fromPersonId" TEXT,
    "fromSource" "BillingResponsibilitySource",
    "toKind" "BillingResponsibleKind" NOT NULL,
    "toOrganizationId" TEXT,
    "toPersonId" TEXT,
    "toSource" "BillingResponsibilitySource" NOT NULL,
    "reason" TEXT,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistrationBillingResponsibilityChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizationBillingContact_organizationId_effectiveFrom_idx" ON "OrganizationBillingContact"("organizationId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationBillingResponsibility_registrationId_key" ON "RegistrationBillingResponsibility"("registrationId");

-- CreateIndex
CREATE INDEX "RegistrationBillingResponsibility_eventId_kind_idx" ON "RegistrationBillingResponsibility"("eventId", "kind");

-- CreateIndex
CREATE INDEX "RegistrationBillingResponsibility_organizationId_idx" ON "RegistrationBillingResponsibility"("organizationId");

-- CreateIndex
CREATE INDEX "RegistrationBillingResponsibilityChange_registrationId_crea_idx" ON "RegistrationBillingResponsibilityChange"("registrationId", "createdAt");

-- CreateIndex
CREATE INDEX "RegistrationBillingResponsibilityChange_eventId_createdAt_idx" ON "RegistrationBillingResponsibilityChange"("eventId", "createdAt");

-- AddForeignKey
ALTER TABLE "OrganizationBillingContact" ADD CONSTRAINT "OrganizationBillingContact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationBillingContact" ADD CONSTRAINT "OrganizationBillingContact_verifiedByUserId_fkey" FOREIGN KEY ("verifiedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationBillingContact" ADD CONSTRAINT "OrganizationBillingContact_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationBillingContact" ADD CONSTRAINT "OrganizationBillingContact_endedByUserId_fkey" FOREIGN KEY ("endedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationBillingResponsibility" ADD CONSTRAINT "RegistrationBillingResponsibility_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationBillingResponsibility" ADD CONSTRAINT "RegistrationBillingResponsibility_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationBillingResponsibility" ADD CONSTRAINT "RegistrationBillingResponsibility_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationBillingResponsibility" ADD CONSTRAINT "RegistrationBillingResponsibility_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationBillingResponsibility" ADD CONSTRAINT "RegistrationBillingResponsibility_setByUserId_fkey" FOREIGN KEY ("setByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationBillingResponsibilityChange" ADD CONSTRAINT "RegistrationBillingResponsibilityChange_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationBillingResponsibilityChange" ADD CONSTRAINT "RegistrationBillingResponsibilityChange_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationBillingResponsibilityChange" ADD CONSTRAINT "RegistrationBillingResponsibilityChange_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- At most one active (not ended) billing contact per organization. Replacing a contact ends the
-- previous row and inserts the new one in one transaction; the database settles a race.
CREATE UNIQUE INDEX "OrganizationBillingContact_one_active_per_organization" ON "OrganizationBillingContact"("organizationId") WHERE "effectiveTo" IS NULL;

ALTER TABLE "OrganizationBillingContact" ADD CONSTRAINT "OrganizationBillingContact_effective_range" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom");
ALTER TABLE "OrganizationBillingContact" ADD CONSTRAINT "OrganizationBillingContact_text_present" CHECK (length(btrim("name")) > 0 AND length(btrim("email")) > 0 AND length(btrim("roleLabel")) > 0);

-- A contact is never deleted, only ended.
CREATE FUNCTION "OrganizationBillingContact_refuse_delete"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'An organization billing contact is ended, never deleted.' USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "OrganizationBillingContact_no_delete" BEFORE DELETE ON "OrganizationBillingContact" FOR EACH ROW EXECUTE FUNCTION "OrganizationBillingContact_refuse_delete"();

-- The responsible party matches its kind: an organization, a person, or neither (unresolved).
ALTER TABLE "RegistrationBillingResponsibility" ADD CONSTRAINT "RegistrationBillingResponsibility_party_matches_kind" CHECK (
  ("kind" = 'ORGANIZATION' AND "organizationId" IS NOT NULL AND "personId" IS NULL)
  OR ("kind" = 'PERSON' AND "personId" IS NOT NULL AND "organizationId" IS NULL)
  OR ("kind" = 'UNRESOLVED' AND "organizationId" IS NULL AND "personId" IS NULL)
);

-- A staff decision names a party, and an override carries its reason.
ALTER TABLE "RegistrationBillingResponsibility" ADD CONSTRAINT "RegistrationBillingResponsibility_staff_source_rules" CHECK (
  ("source" NOT IN ('STAFF_LINKED', 'STAFF_OVERRIDE') OR "kind" <> 'UNRESOLVED')
  AND ("source" <> 'STAFF_OVERRIDE' OR length(btrim(coalesce("reason", ''))) > 0)
);

-- The history is append-only. Two things are allowed, both only from inside a foreign-key action
-- (pg_trigger_depth() > 1, never from a direct statement): the actor column clearing itself when
-- that user is deleted, and the rows going when their event or registration is deleted.
CREATE FUNCTION "RegistrationBillingResponsibilityChange_refuse_change"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Billing responsibility history is append-only.' USING ERRCODE = '23001';
  END IF;
  IF pg_trigger_depth() > 1 AND NEW."actorUserId" IS NULL AND (to_jsonb(NEW) - 'actorUserId') = (to_jsonb(OLD) - 'actorUserId') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Billing responsibility history is append-only.' USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "RegistrationBillingResponsibilityChange_append_only" BEFORE UPDATE OR DELETE ON "RegistrationBillingResponsibilityChange" FOR EACH ROW EXECUTE FUNCTION "RegistrationBillingResponsibilityChange_refuse_change"();

-- A contact row is only ever ended or verified, never rewritten: effectiveTo, endedByUserId,
-- endReason, verifiedAt and verifiedByUserId may go from NULL to a value; nothing else changes.
-- A user foreign key may clear itself (ON DELETE SET NULL, from inside a foreign-key action).
CREATE FUNCTION "OrganizationBillingContact_guard_update"() RETURNS trigger AS $$
DECLARE
  user_columns CONSTANT text[] := ARRAY['verifiedByUserId', 'createdByUserId', 'endedByUserId'];
  once_columns CONSTANT text[] := ARRAY['effectiveTo', 'endedByUserId', 'endReason', 'verifiedAt', 'verifiedByUserId'];
  column_name text;
  old_json jsonb := to_jsonb(OLD);
  new_json jsonb := to_jsonb(NEW);
BEGIN
  IF pg_trigger_depth() > 1 THEN
    -- Only the user columns may differ, and only by becoming NULL.
    IF (new_json - user_columns) = (old_json - user_columns) THEN
      FOREACH column_name IN ARRAY user_columns LOOP
        IF new_json -> column_name IS DISTINCT FROM old_json -> column_name AND new_json -> column_name <> 'null'::jsonb THEN
          RAISE EXCEPTION 'An organization billing contact is not rewritten.' USING ERRCODE = '23001';
        END IF;
      END LOOP;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'An organization billing contact is not rewritten.' USING ERRCODE = '23001';
  END IF;
  IF (new_json - once_columns) <> (old_json - once_columns) THEN
    RAISE EXCEPTION 'An organization billing contact is not rewritten.' USING ERRCODE = '23001';
  END IF;
  FOREACH column_name IN ARRAY once_columns LOOP
    IF old_json -> column_name <> 'null'::jsonb AND new_json -> column_name IS DISTINCT FROM old_json -> column_name THEN
      RAISE EXCEPTION 'An organization billing contact is not rewritten.' USING ERRCODE = '23001';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "OrganizationBillingContact_guard_update" BEFORE UPDATE ON "OrganizationBillingContact" FOR EACH ROW EXECUTE FUNCTION "OrganizationBillingContact_guard_update"();
