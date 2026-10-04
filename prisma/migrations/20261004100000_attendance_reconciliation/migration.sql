-- CreateEnum
CREATE TYPE "AttendanceCorrectionKind" AS ENUM ('MARK_ATTENDED', 'MARK_NOT_ATTENDED', 'CLEAR');

-- CreateEnum
CREATE TYPE "AttendanceReconciliationStatus" AS ENUM ('DRAFT', 'APPROVED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "AttendanceCorrection" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "registrationAttendeeId" TEXT NOT NULL,
    "kind" "AttendanceCorrectionKind" NOT NULL,
    "reason" TEXT NOT NULL,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),
    "supersededByCorrectionId" TEXT,

    CONSTRAINT "AttendanceCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceReconciliationVersion" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "status" "AttendanceReconciliationStatus" NOT NULL DEFAULT 'DRAFT',
    "fingerprint" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "invoiceGrouping" "InvoiceGrouping" NOT NULL,
    "registeredCount" INTEGER NOT NULL,
    "checkedInCount" INTEGER NOT NULL,
    "noShowCount" INTEGER NOT NULL,
    "addedByStaffCount" INTEGER NOT NULL,
    "removedByStaffCount" INTEGER NOT NULL,
    "billableCount" INTEGER NOT NULL,
    "estimatedCents" INTEGER NOT NULL,
    "billableCents" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "preparedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "supersededByVersionId" TEXT,

    CONSTRAINT "AttendanceReconciliationVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceReviewAcknowledgement" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "reviewKey" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceReviewAcknowledgement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AttendanceCorrection_eventId_createdAt_idx" ON "AttendanceCorrection"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "AttendanceCorrection_registrationId_idx" ON "AttendanceCorrection"("registrationId");

-- CreateIndex
CREATE INDEX "AttendanceCorrection_registrationAttendeeId_createdAt_idx" ON "AttendanceCorrection"("registrationAttendeeId", "createdAt");

-- CreateIndex
CREATE INDEX "AttendanceReconciliationVersion_eventId_status_idx" ON "AttendanceReconciliationVersion"("eventId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceReconciliationVersion_eventId_versionNumber_key" ON "AttendanceReconciliationVersion"("eventId", "versionNumber");

-- CreateIndex
CREATE INDEX "AttendanceReviewAcknowledgement_eventId_createdAt_idx" ON "AttendanceReviewAcknowledgement"("eventId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceReviewAcknowledgement_registrationId_reviewKey_key" ON "AttendanceReviewAcknowledgement"("registrationId", "reviewKey");

-- AddForeignKey
ALTER TABLE "AttendanceCorrection" ADD CONSTRAINT "AttendanceCorrection_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceCorrection" ADD CONSTRAINT "AttendanceCorrection_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceCorrection" ADD CONSTRAINT "AttendanceCorrection_registrationAttendeeId_fkey" FOREIGN KEY ("registrationAttendeeId") REFERENCES "RegistrationAttendee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceCorrection" ADD CONSTRAINT "AttendanceCorrection_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceReconciliationVersion" ADD CONSTRAINT "AttendanceReconciliationVersion_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceReconciliationVersion" ADD CONSTRAINT "AttendanceReconciliationVersion_preparedByUserId_fkey" FOREIGN KEY ("preparedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceReconciliationVersion" ADD CONSTRAINT "AttendanceReconciliationVersion_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceReviewAcknowledgement" ADD CONSTRAINT "AttendanceReviewAcknowledgement_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceReviewAcknowledgement" ADD CONSTRAINT "AttendanceReviewAcknowledgement_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceReviewAcknowledgement" ADD CONSTRAINT "AttendanceReviewAcknowledgement_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- #166: reviewed attendance and billable-unit reconciliation. Additive only (two enums, three new
-- tables). Corrections are append-only; a reconciliation version is an immutable snapshot whose
-- only changes are its status transitions. All of it is enforced here, not only in the app.

-- A correction carries its reason; a person has at most one active (not superseded) correction.
ALTER TABLE "AttendanceCorrection" ADD CONSTRAINT "AttendanceCorrection_reason_present" CHECK (length(btrim("reason")) > 0);
ALTER TABLE "AttendanceCorrection" ADD CONSTRAINT "AttendanceCorrection_superseded_pair" CHECK (("supersededAt" IS NULL) = ("supersededByCorrectionId" IS NULL));
CREATE UNIQUE INDEX "AttendanceCorrection_one_active_per_attendee" ON "AttendanceCorrection"("registrationAttendeeId") WHERE "supersededAt" IS NULL;

-- Corrections are never edited or deleted. Allowed: superseding (supersededAt and its pointer
-- go from NULL to a value, nothing else changes); and, only from inside a foreign-key action
-- (pg_trigger_depth() > 1), the actor clearing itself when that user is deleted, and the rows going
-- when their event, registration or attendee is really gone.
CREATE FUNCTION "AttendanceCorrection_guard"() RETURNS trigger AS $$
DECLARE
  superseding CONSTANT text[] := ARRAY['supersededAt', 'supersededByCorrectionId'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 AND (
      NOT EXISTS (SELECT 1 FROM "Event" WHERE "id" = OLD."eventId")
      OR NOT EXISTS (SELECT 1 FROM "Registration" WHERE "id" = OLD."registrationId")
      OR NOT EXISTS (SELECT 1 FROM "RegistrationAttendee" WHERE "id" = OLD."registrationAttendeeId")
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'An attendance correction is never deleted; supersede it with a new one.' USING ERRCODE = '23001';
  END IF;
  IF pg_trigger_depth() > 1 AND NEW."actorUserId" IS NULL AND (to_jsonb(NEW) - 'actorUserId') = (to_jsonb(OLD) - 'actorUserId') THEN
    RETURN NEW;
  END IF;
  IF OLD."supersededAt" IS NULL AND NEW."supersededAt" IS NOT NULL AND NEW."supersededByCorrectionId" IS NOT NULL
     AND (to_jsonb(NEW) - superseding) = (to_jsonb(OLD) - superseding) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'An attendance correction is not rewritten; supersede it with a new one.' USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "AttendanceCorrection_guard" BEFORE UPDATE OR DELETE ON "AttendanceCorrection" FOR EACH ROW EXECUTE FUNCTION "AttendanceCorrection_guard"();

-- The counts reconcile: no-shows are the registered people never checked in, and billable people are
-- those checked in, plus staff additions, minus staff removals. A superseded or approved version says when.
ALTER TABLE "AttendanceReconciliationVersion" ADD CONSTRAINT "AttendanceReconciliationVersion_counts_reconcile" CHECK (
  "registeredCount" >= 0 AND "checkedInCount" >= 0 AND "addedByStaffCount" >= 0 AND "removedByStaffCount" >= 0
  AND "billableCount" >= 0 AND "estimatedCents" >= 0 AND "billableCents" >= 0
  AND "noShowCount" = "registeredCount" - "checkedInCount"
  AND "billableCount" = "checkedInCount" + "addedByStaffCount" - "removedByStaffCount"
);
ALTER TABLE "AttendanceReconciliationVersion" ADD CONSTRAINT "AttendanceReconciliationVersion_status_fields" CHECK (
  ("status" <> 'APPROVED' OR ("approvedAt" IS NOT NULL AND "supersededAt" IS NULL))
  AND ("status" <> 'SUPERSEDED' OR "supersededAt" IS NOT NULL)
  AND ("status" <> 'DRAFT' OR ("approvedAt" IS NULL AND "supersededAt" IS NULL))
);

-- Re-preparing with the same facts returns the existing version: only one non-superseded version
-- per event may carry a fingerprint (parallel prepares settle here), and at most one is approved
-- (parallel approvals settle here).
CREATE UNIQUE INDEX "AttendanceReconciliationVersion_one_live_per_fingerprint" ON "AttendanceReconciliationVersion"("eventId", "fingerprint") WHERE "status" <> 'SUPERSEDED';
CREATE UNIQUE INDEX "AttendanceReconciliationVersion_one_approved_per_event" ON "AttendanceReconciliationVersion"("eventId") WHERE "status" = 'APPROVED';

-- A version is created as a draft, is an immutable snapshot, and only moves
-- DRAFT -> APPROVED, DRAFT -> SUPERSEDED or APPROVED -> SUPERSEDED. Only status, approval and
-- supersession columns may change. From inside a foreign-key action (pg_trigger_depth() > 1): the
-- preparer or approver clearing itself when that user is deleted, and the rows going when the event is gone.
CREATE FUNCTION "AttendanceReconciliationVersion_guard"() RETURNS trigger AS $$
DECLARE
  mutable CONSTANT text[] := ARRAY['status', 'approvedByUserId', 'approvedAt', 'supersededAt', 'supersededByVersionId'];
  user_columns CONSTANT text[] := ARRAY['preparedByUserId', 'approvedByUserId'];
  column_name text;
  old_json jsonb;
  new_json jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'A reconciliation version starts as a draft.' USING ERRCODE = '23001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 AND NOT EXISTS (SELECT 1 FROM "Event" WHERE "id" = OLD."eventId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'A reconciliation version is never deleted.' USING ERRCODE = '23001';
  END IF;
  old_json := to_jsonb(OLD);
  new_json := to_jsonb(NEW);
  IF pg_trigger_depth() > 1 AND (new_json - user_columns) = (old_json - user_columns) THEN
    FOREACH column_name IN ARRAY user_columns LOOP
      IF new_json -> column_name IS DISTINCT FROM old_json -> column_name AND new_json -> column_name <> 'null'::jsonb THEN
        RAISE EXCEPTION 'A reconciliation version is not rewritten.' USING ERRCODE = '23001';
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;
  IF (new_json - mutable) <> (old_json - mutable) THEN
    RAISE EXCEPTION 'A reconciliation version is an immutable snapshot.' USING ERRCODE = '23001';
  END IF;
  IF OLD."status" = 'DRAFT' AND NEW."status" = 'APPROVED' AND NEW."approvedAt" IS NOT NULL AND NEW."supersededAt" IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'DRAFT' AND NEW."status" = 'SUPERSEDED' AND NEW."supersededAt" IS NOT NULL
     AND NEW."approvedAt" IS NULL AND NEW."approvedByUserId" IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'APPROVED' AND NEW."status" = 'SUPERSEDED' AND NEW."supersededAt" IS NOT NULL
     AND NEW."approvedAt" IS NOT DISTINCT FROM OLD."approvedAt" AND NEW."approvedByUserId" IS NOT DISTINCT FROM OLD."approvedByUserId" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'That reconciliation version change is not allowed.' USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "AttendanceReconciliationVersion_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AttendanceReconciliationVersion" FOR EACH ROW EXECUTE FUNCTION "AttendanceReconciliationVersion_guard"();

-- A roster-review acknowledgement carries its reason, is never edited or deleted (only the actor
-- clearing itself when that user is deleted, and the rows going with their event or registration,
-- both only from inside a foreign-key action).
ALTER TABLE "AttendanceReviewAcknowledgement" ADD CONSTRAINT "AttendanceReviewAcknowledgement_reason_present" CHECK (length(btrim("reason")) > 0);
CREATE FUNCTION "AttendanceReviewAcknowledgement_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 AND (
      NOT EXISTS (SELECT 1 FROM "Event" WHERE "id" = OLD."eventId")
      OR NOT EXISTS (SELECT 1 FROM "Registration" WHERE "id" = OLD."registrationId")
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'A roster-review acknowledgement is never deleted.' USING ERRCODE = '23001';
  END IF;
  IF pg_trigger_depth() > 1 AND NEW."actorUserId" IS NULL AND (to_jsonb(NEW) - 'actorUserId') = (to_jsonb(OLD) - 'actorUserId') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A roster-review acknowledgement is not rewritten.' USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "AttendanceReviewAcknowledgement_guard" BEFORE UPDATE OR DELETE ON "AttendanceReviewAcknowledgement" FOR EACH ROW EXECUTE FUNCTION "AttendanceReviewAcknowledgement_guard"();
