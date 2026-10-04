-- CreateEnum
CREATE TYPE "InvoiceVersionStatus" AS ENUM ('DRAFT', 'FINALIZED', 'SUPERSEDED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "InvoiceVersionBasis" AS ENUM ('RECONCILIATION', 'CONTACT_ONLY_COPY');

-- CreateEnum
CREATE TYPE "InvoiceReceivableStatus" AS ENUM ('OPEN', 'SUPERSEDED');

-- AlterEnum
ALTER TYPE "EventPermission" ADD VALUE 'FINALIZE_INVOICES';

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "invoiceCode" TEXT;

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "groupKey" TEXT NOT NULL,
    "invoiceGrouping" "InvoiceGrouping" NOT NULL,
    "partyKind" "BillingResponsibleKind" NOT NULL,
    "partyId" TEXT,
    "clubId" TEXT,
    "baseNumber" TEXT,
    "numberCode" TEXT,
    "numberYear" INTEGER,
    "numberSequence" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceVersion" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" "InvoiceVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "basis" "InvoiceVersionBasis" NOT NULL,
    "supersedesVersionId" TEXT,
    "reconciliationVersionId" TEXT NOT NULL,
    "number" TEXT,
    "groupTitle" TEXT NOT NULL,
    "organizationName" TEXT NOT NULL,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactRoleLabel" TEXT,
    "contactVerified" BOOLEAN NOT NULL DEFAULT false,
    "registeredCount" INTEGER NOT NULL,
    "billableCount" INTEGER NOT NULL,
    "amountDueCents" INTEGER NOT NULL,
    "amountsFingerprint" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "revisionReason" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "regenerationCount" INTEGER NOT NULL DEFAULT 0,
    "regeneratedAt" TIMESTAMP(3),
    "finalizedAt" TIMESTAMP(3),
    "finalizedByUserId" TEXT,
    "finalizedByName" TEXT,
    "finalizeIdempotencyKey" TEXT,
    "supersededAt" TIMESTAMP(3),
    "supersededByVersionId" TEXT,
    "discardedAt" TIMESTAMP(3),

    CONSTRAINT "InvoiceVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceReceivable" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "invoiceVersionId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "InvoiceReceivableStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),
    "supersededByVersionId" TEXT,

    CONSTRAINT "InvoiceReceivable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceNumberCounter" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "lastNumber" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceNumberCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_baseNumber_key" ON "Invoice"("baseNumber");

-- CreateIndex
CREATE INDEX "Invoice_eventId_idx" ON "Invoice"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_eventId_groupKey_key" ON "Invoice"("eventId", "groupKey");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceVersion_number_key" ON "InvoiceVersion"("number");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceVersion_finalizeIdempotencyKey_key" ON "InvoiceVersion"("finalizeIdempotencyKey");

-- CreateIndex
CREATE INDEX "InvoiceVersion_eventId_status_idx" ON "InvoiceVersion"("eventId", "status");

-- CreateIndex
CREATE INDEX "InvoiceVersion_reconciliationVersionId_idx" ON "InvoiceVersion"("reconciliationVersionId");

-- CreateIndex
CREATE INDEX "InvoiceVersion_invoiceId_revision_idx" ON "InvoiceVersion"("invoiceId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceReceivable_invoiceVersionId_key" ON "InvoiceReceivable"("invoiceVersionId");

-- CreateIndex
CREATE INDEX "InvoiceReceivable_eventId_status_idx" ON "InvoiceReceivable"("eventId", "status");

-- CreateIndex
CREATE INDEX "InvoiceReceivable_invoiceId_idx" ON "InvoiceReceivable"("invoiceId");

-- CreateIndex
CREATE INDEX "InvoiceNumberCounter_eventId_idx" ON "InvoiceNumberCounter"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceNumberCounter_code_year_key" ON "InvoiceNumberCounter"("code", "year");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceVersion" ADD CONSTRAINT "InvoiceVersion_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceVersion" ADD CONSTRAINT "InvoiceVersion_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceVersion" ADD CONSTRAINT "InvoiceVersion_reconciliationVersionId_fkey" FOREIGN KEY ("reconciliationVersionId") REFERENCES "AttendanceReconciliationVersion"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceVersion" ADD CONSTRAINT "InvoiceVersion_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceVersion" ADD CONSTRAINT "InvoiceVersion_finalizedByUserId_fkey" FOREIGN KEY ("finalizedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceReceivable" ADD CONSTRAINT "InvoiceReceivable_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceReceivable" ADD CONSTRAINT "InvoiceReceivable_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceReceivable" ADD CONSTRAINT "InvoiceReceivable_invoiceVersionId_fkey" FOREIGN KEY ("invoiceVersionId") REFERENCES "InvoiceVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceNumberCounter" ADD CONSTRAINT "InvoiceNumberCounter_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;




-- #167: deferred-organization invoices. Additive only (three enums, one enum value, one nullable Event
-- column, four new tables). A draft is replaced only by regeneration; a finalized version is an
-- immutable snapshot that only moves to SUPERSEDED; the invoice number is assigned once; the running
-- number only counts up. All of it is enforced here, not only in the app.

ALTER TABLE "Event" ADD CONSTRAINT "Event_invoiceCode_shape" CHECK ("invoiceCode" IS NULL OR "invoiceCode" ~ '^[A-Z]{2,6}$');

-- The invoice code cannot change once the event has a number series (a number was issued with it).
CREATE FUNCTION "Event_invoiceCode_guard"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "InvoiceNumberCounter" WHERE "eventId" = OLD."id") THEN
    RAISE EXCEPTION 'The invoice code is locked: invoice numbers were already issued for this event.' USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Event_invoiceCode_guard" BEFORE UPDATE OF "invoiceCode" ON "Event" FOR EACH ROW WHEN (OLD."invoiceCode" IS DISTINCT FROM NEW."invoiceCode") EXECUTE FUNCTION "Event_invoiceCode_guard"();

-- The running number: one row per (code, year); it only ever counts up by one, and goes only with its event.
ALTER TABLE "InvoiceNumberCounter" ADD CONSTRAINT "InvoiceNumberCounter_shape" CHECK ("code" ~ '^[A-Z]{2,6}$' AND "year" BETWEEN 2000 AND 2999 AND "lastNumber" >= 1);
CREATE FUNCTION "InvoiceNumberCounter_guard"() RETURNS trigger AS $$
DECLARE
  counting CONSTANT text[] := ARRAY['lastNumber', 'updatedAt'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 AND NOT EXISTS (SELECT 1 FROM "Event" WHERE "id" = OLD."eventId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'An invoice number counter is never deleted.' USING ERRCODE = '23001';
  END IF;
  IF NEW."lastNumber" = OLD."lastNumber" + 1 AND (to_jsonb(NEW) - counting) = (to_jsonb(OLD) - counting) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'An invoice number counter only counts up by one.' USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "InvoiceNumberCounter_guard" BEFORE UPDATE OR DELETE ON "InvoiceNumberCounter" FOR EACH ROW EXECUTE FUNCTION "InvoiceNumberCounter_guard"();

-- An invoice: numbering columns are all set together or all null, and the number matches them
-- (SC27-0001 is code SC, year 2027, sequence 1). It is created without a number; the only update
-- allowed is assigning the number once.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_number_together" CHECK (
  ("baseNumber" IS NULL AND "numberCode" IS NULL AND "numberYear" IS NULL AND "numberSequence" IS NULL)
  OR ("baseNumber" IS NOT NULL AND "numberCode" IS NOT NULL AND "numberYear" IS NOT NULL AND "numberSequence" IS NOT NULL
      AND "numberSequence" >= 1
      AND "baseNumber" = "numberCode" || lpad(("numberYear" % 100)::text, 2, '0') || '-' || lpad("numberSequence"::text, 4, '0'))
);
CREATE FUNCTION "Invoice_guard"() RETURNS trigger AS $$
DECLARE
  numbering CONSTANT text[] := ARRAY['baseNumber', 'numberCode', 'numberYear', 'numberSequence', 'invoiceGrouping'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."baseNumber" IS NOT NULL THEN
      RAISE EXCEPTION 'An invoice is created without a number; the number is assigned at finalization.' USING ERRCODE = '23001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 AND NOT EXISTS (SELECT 1 FROM "Event" WHERE "id" = OLD."eventId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'An invoice is never deleted.' USING ERRCODE = '23001';
  END IF;
  -- Until it has a number an invoice follows the event's current grouping; a numbered invoice is fixed.
  IF OLD."baseNumber" IS NULL AND (to_jsonb(NEW) - numbering) = (to_jsonb(OLD) - numbering) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'An invoice number is assigned once and never changed.' USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Invoice_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Invoice" FOR EACH ROW EXECUTE FUNCTION "Invoice_guard"();

-- A version's shape. A revision supersedes the finalized version it revises; the original does not.
-- A finalized or superseded version has a number, an approver and an idempotency key.
ALTER TABLE "InvoiceVersion" ADD CONSTRAINT "InvoiceVersion_shape" CHECK (
  "revision" >= 0 AND ("revision" = 0) = ("supersedesVersionId" IS NULL)
  AND "amountDueCents" >= 0 AND "registeredCount" >= 0 AND "billableCount" >= 0 AND "billableCount" <= "registeredCount"
  AND ("number" IS NULL OR "number" ~ '^[A-Z]{2,6}[0-9]{2}-[0-9]{4,}(-R[0-9]+)?$')
);
ALTER TABLE "InvoiceVersion" ADD CONSTRAINT "InvoiceVersion_status_fields" CHECK (
  ("status" <> 'DRAFT' OR ("number" IS NULL AND "finalizedAt" IS NULL AND "finalizedByUserId" IS NULL AND "finalizedByName" IS NULL AND "finalizeIdempotencyKey" IS NULL AND "supersededAt" IS NULL AND "supersededByVersionId" IS NULL AND "discardedAt" IS NULL))
  AND ("status" <> 'FINALIZED' OR ("number" IS NOT NULL AND "finalizedAt" IS NOT NULL AND "finalizedByName" IS NOT NULL AND "finalizeIdempotencyKey" IS NOT NULL AND "supersededAt" IS NULL))
  AND ("status" <> 'SUPERSEDED' OR ("number" IS NOT NULL AND "finalizedAt" IS NOT NULL AND "supersededAt" IS NOT NULL))
  AND ("status" <> 'DISCARDED' OR ("number" IS NULL AND "finalizedAt" IS NULL AND "supersededAt" IS NULL AND "discardedAt" IS NOT NULL))
);
-- A discarded draft frees its revision number: one non-discarded version per invoice and revision.
CREATE UNIQUE INDEX "InvoiceVersion_one_live_per_revision" ON "InvoiceVersion"("invoiceId", "revision") WHERE "status" <> 'DISCARDED';
-- One open draft and one live finalized version per invoice (parallel writers settle here).
CREATE UNIQUE INDEX "InvoiceVersion_one_draft_per_invoice" ON "InvoiceVersion"("invoiceId") WHERE "status" = 'DRAFT';
CREATE UNIQUE INDEX "InvoiceVersion_one_finalized_per_invoice" ON "InvoiceVersion"("invoiceId") WHERE "status" = 'FINALIZED';

-- DRAFT -> DISCARDED throws a draft away (status and discardedAt only); it is never numbered and nothing reopens it.
-- DRAFT -> DRAFT is a regeneration (counted, nothing about identity changes). DRAFT -> FINALIZED assigns
-- the number (which must be the invoice's number, plus -R<revision> for a revision), the approver and the
-- key, and changes nothing else. FINALIZED -> SUPERSEDED records the supersession and changes nothing else.
-- Nothing else is allowed. From inside a foreign-key action (pg_trigger_depth() > 1): the creator or
-- approver clearing itself when that user is deleted, and the rows going when the event is gone.
CREATE FUNCTION "InvoiceVersion_guard"() RETURNS trigger AS $$
DECLARE
  user_columns CONSTANT text[] := ARRAY['createdByUserId', 'finalizedByUserId'];
  regenerating CONSTANT text[] := ARRAY['groupTitle', 'organizationName', 'contactName', 'contactEmail', 'contactRoleLabel', 'contactVerified', 'registeredCount', 'billableCount', 'amountDueCents', 'amountsFingerprint', 'snapshot', 'revisionReason', 'regenerationCount', 'regeneratedAt', 'reconciliationVersionId'];
  finalizing CONSTANT text[] := ARRAY['status', 'number', 'finalizedAt', 'finalizedByUserId', 'finalizedByName', 'finalizeIdempotencyKey'];
  superseding CONSTANT text[] := ARRAY['status', 'supersededAt', 'supersededByVersionId'];
  discarding CONSTANT text[] := ARRAY['status', 'discardedAt'];
  column_name text;
  old_json jsonb;
  new_json jsonb;
  base text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'An invoice version starts as a draft.' USING ERRCODE = '23001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 AND NOT EXISTS (SELECT 1 FROM "Event" WHERE "id" = OLD."eventId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'An invoice version is never deleted.' USING ERRCODE = '23001';
  END IF;
  old_json := to_jsonb(OLD);
  new_json := to_jsonb(NEW);
  IF pg_trigger_depth() > 1 AND (new_json - user_columns) = (old_json - user_columns) THEN
    FOREACH column_name IN ARRAY user_columns LOOP
      IF new_json -> column_name IS DISTINCT FROM old_json -> column_name AND new_json -> column_name <> 'null'::jsonb THEN
        RAISE EXCEPTION 'An invoice version is not rewritten.' USING ERRCODE = '23001';
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'DRAFT' AND NEW."status" = 'DRAFT' THEN
    IF (new_json - regenerating) <> (old_json - regenerating) THEN
      RAISE EXCEPTION 'A draft changes only by regeneration.' USING ERRCODE = '23001';
    END IF;
    IF NEW."regenerationCount" <> OLD."regenerationCount" + 1 THEN
      RAISE EXCEPTION 'A draft is regenerated one step at a time.' USING ERRCODE = '23001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'DRAFT' AND NEW."status" = 'DISCARDED' THEN
    IF (new_json - discarding) <> (old_json - discarding) THEN
      RAISE EXCEPTION 'Discarding a draft changes nothing else.' USING ERRCODE = '23001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'DRAFT' AND NEW."status" = 'FINALIZED' THEN
    IF (new_json - finalizing) <> (old_json - finalizing) THEN
      RAISE EXCEPTION 'Finalizing changes only the number and the approval.' USING ERRCODE = '23001';
    END IF;
    SELECT "baseNumber" INTO base FROM "Invoice" WHERE "id" = NEW."invoiceId";
    IF base IS NULL OR NEW."number" IS DISTINCT FROM (base || CASE WHEN NEW."revision" = 0 THEN '' ELSE '-R' || NEW."revision"::text END) THEN
      RAISE EXCEPTION 'The invoice number does not match the invoice.' USING ERRCODE = '23001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'FINALIZED' AND NEW."status" = 'SUPERSEDED' THEN
    IF (new_json - superseding) <> (old_json - superseding) THEN
      RAISE EXCEPTION 'A finalized invoice version is an immutable snapshot.' USING ERRCODE = '23001';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A finalized invoice version is an immutable snapshot.' USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "InvoiceVersion_guard" BEFORE INSERT OR UPDATE OR DELETE ON "InvoiceVersion" FOR EACH ROW EXECUTE FUNCTION "InvoiceVersion_guard"();

-- The receivable: one per finalized version, for exactly that version's amount, OPEN until the version is
-- superseded; one OPEN per invoice. Created OPEN only; the only update allowed is OPEN -> SUPERSEDED.
ALTER TABLE "InvoiceReceivable" ADD CONSTRAINT "InvoiceReceivable_shape" CHECK (
  "amountCents" >= 0
  AND ("status" <> 'OPEN' OR ("supersededAt" IS NULL AND "supersededByVersionId" IS NULL))
  AND ("status" <> 'SUPERSEDED' OR ("supersededAt" IS NOT NULL AND "supersededByVersionId" IS NOT NULL))
);
CREATE UNIQUE INDEX "InvoiceReceivable_one_open_per_invoice" ON "InvoiceReceivable"("invoiceId") WHERE "status" = 'OPEN';
CREATE FUNCTION "InvoiceReceivable_guard"() RETURNS trigger AS $$
DECLARE
  superseding CONSTANT text[] := ARRAY['status', 'supersededAt', 'supersededByVersionId'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'A receivable starts open.' USING ERRCODE = '23001';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "InvoiceVersion"
      WHERE "id" = NEW."invoiceVersionId" AND "invoiceId" = NEW."invoiceId" AND "eventId" = NEW."eventId"
        AND "status" = 'FINALIZED' AND "amountDueCents" = NEW."amountCents"
    ) THEN
      RAISE EXCEPTION 'A receivable matches exactly one finalized invoice version and its amount.' USING ERRCODE = '23001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 AND NOT EXISTS (SELECT 1 FROM "Event" WHERE "id" = OLD."eventId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'A receivable is never deleted.' USING ERRCODE = '23001';
  END IF;
  IF OLD."status" = 'OPEN' AND NEW."status" = 'SUPERSEDED' AND (to_jsonb(NEW) - superseding) = (to_jsonb(OLD) - superseding) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A receivable is not rewritten.' USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "InvoiceReceivable_guard" BEFORE INSERT OR UPDATE OR DELETE ON "InvoiceReceivable" FOR EACH ROW EXECUTE FUNCTION "InvoiceReceivable_guard"();
