-- Church invoice PDF: match the conference sample layout (#780).
-- Additive columns only, then the invoice-version guard is replaced so a DRAFT's manual lines can change (and nothing
-- else about it) without a regeneration, while a FINALIZED or SUPERSEDED version stays an immutable snapshot.

ALTER TABLE "PlatformSettings"
  ADD COLUMN "invoiceHeaderDepartment" TEXT,
  ADD COLUMN "invoiceHeaderOrganization" TEXT,
  ADD COLUMN "invoiceHeaderAddress" TEXT,
  ADD COLUMN "invoiceHeaderPhone" TEXT;

ALTER TABLE "Event" ADD COLUMN "invoiceClubType" TEXT;

ALTER TABLE "InvoiceVersion" ADD COLUMN "manualLines" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "InvoiceVersion" ADD CONSTRAINT "InvoiceVersion_manual_lines_array" CHECK (jsonb_typeof("manualLines") = 'array' AND jsonb_array_length("manualLines") <= 50);

ALTER TABLE "InvoiceVersionDocument" ADD COLUMN "layoutInputs" JSONB;

-- Same rules as before. The only addition is the "editing_lines" branch below: DRAFT -> DRAFT that changes only
-- manualLines, amountDueCents and amountsFingerprint. FINALIZING still changes none of them (they are not in the
-- finalizing list), so the lines freeze with the version exactly as the snapshot does.
CREATE OR REPLACE FUNCTION "InvoiceVersion_guard"() RETURNS trigger AS $$
DECLARE
  user_columns CONSTANT text[] := ARRAY['createdByUserId', 'finalizedByUserId'];
  regenerating CONSTANT text[] := ARRAY['groupTitle', 'organizationName', 'contactName', 'contactEmail', 'contactRoleLabel', 'contactVerified', 'registeredCount', 'billableCount', 'amountDueCents', 'amountsFingerprint', 'snapshot', 'revisionReason', 'regenerationCount', 'regeneratedAt', 'reconciliationVersionId'];
  finalizing CONSTANT text[] := ARRAY['status', 'number', 'finalizedAt', 'finalizedByUserId', 'finalizedByName', 'finalizeIdempotencyKey'];
  superseding CONSTANT text[] := ARRAY['status', 'supersededAt', 'supersededByVersionId'];
  discarding CONSTANT text[] := ARRAY['status', 'discardedAt'];
  editing_lines CONSTANT text[] := ARRAY['manualLines', 'amountDueCents', 'amountsFingerprint'];
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
  -- Staff adding or removing a manual line (#780) changes the lines and the totals that include them, and nothing else.
  IF OLD."status" = 'DRAFT' AND NEW."status" = 'DRAFT' AND (new_json - editing_lines) = (old_json - editing_lines) THEN
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
