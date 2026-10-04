-- #168 slice 4: invoice delivery, AR postings, manual payments and statements. Additive only: two enum
-- values, one nullable column on each of Event and MessageOutbox, and new tables. Nothing existing is changed.

-- CreateEnum
CREATE TYPE "InvoicePaymentEntryKind" AS ENUM ('PAYMENT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "InvoiceRecipientKind" AS ENUM ('BILLING_CONTACT', 'CLUB_DIRECTOR');

-- AlterEnum
ALTER TYPE "MessageRecipientKind" ADD VALUE 'BILLING_CONTACT';

-- AlterEnum
ALTER TYPE "MessageTemplateKey" ADD VALUE 'INVOICE_DELIVERY';

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "invoicePaymentInstructions" TEXT;

-- AlterTable
ALTER TABLE "MessageOutbox" ADD COLUMN     "attachmentId" TEXT;

-- CreateTable
CREATE TABLE "MessageAttachment" (
    "id" TEXT NOT NULL,
    "eventId" TEXT,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceVersionDocument" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "invoiceVersionId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "generatorVersion" INTEGER NOT NULL,
    "paymentInstructions" TEXT NOT NULL,
    "headerName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceVersionDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceDelivery" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "invoiceVersionId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "sentByUserId" TEXT,
    "sentByName" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "contactChangedSinceFinalization" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceDeliveryRecipient" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "kind" "InvoiceRecipientKind" NOT NULL,
    "attendeeAccountId" TEXT,
    "clubId" TEXT,
    "messageOutboxId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceDeliveryRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceArPosting" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "invoiceVersionId" TEXT NOT NULL,
    "postedOn" DATE NOT NULL,
    "reference" TEXT,
    "correctsPostingId" TEXT,
    "reason" TEXT,
    "recordedByUserId" TEXT,
    "recordedByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceArPosting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoicePayment" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "invoiceVersionId" TEXT NOT NULL,
    "receivableId" TEXT NOT NULL,
    "kind" "InvoicePaymentEntryKind" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "checkNumber" TEXT,
    "receivedOn" DATE NOT NULL,
    "note" TEXT,
    "reversesPaymentId" TEXT,
    "reason" TEXT,
    "requestKey" TEXT,
    "recordedByUserId" TEXT,
    "recordedByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoicePayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageAttachment_eventId_idx" ON "MessageAttachment"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceVersionDocument_invoiceVersionId_key" ON "InvoiceVersionDocument"("invoiceVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceVersionDocument_attachmentId_key" ON "InvoiceVersionDocument"("attachmentId");

-- CreateIndex
CREATE INDEX "InvoiceVersionDocument_eventId_idx" ON "InvoiceVersionDocument"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceDelivery_idempotencyKey_key" ON "InvoiceDelivery"("idempotencyKey");

-- CreateIndex
CREATE INDEX "InvoiceDelivery_eventId_createdAt_idx" ON "InvoiceDelivery"("eventId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceDelivery_invoiceVersionId_sequence_key" ON "InvoiceDelivery"("invoiceVersionId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceDeliveryRecipient_messageOutboxId_key" ON "InvoiceDeliveryRecipient"("messageOutboxId");

-- CreateIndex
CREATE INDEX "InvoiceDeliveryRecipient_deliveryId_idx" ON "InvoiceDeliveryRecipient"("deliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceArPosting_correctsPostingId_key" ON "InvoiceArPosting"("correctsPostingId");

-- CreateIndex
CREATE INDEX "InvoiceArPosting_invoiceId_createdAt_idx" ON "InvoiceArPosting"("invoiceId", "createdAt");

-- CreateIndex
CREATE INDEX "InvoiceArPosting_eventId_idx" ON "InvoiceArPosting"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoicePayment_reversesPaymentId_key" ON "InvoicePayment"("reversesPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoicePayment_requestKey_key" ON "InvoicePayment"("requestKey");

-- CreateIndex
CREATE INDEX "InvoicePayment_invoiceId_createdAt_idx" ON "InvoicePayment"("invoiceId", "createdAt");

-- CreateIndex
CREATE INDEX "InvoicePayment_eventId_idx" ON "InvoicePayment"("eventId");

-- CreateIndex
CREATE INDEX "MessageOutbox_attachmentId_idx" ON "MessageOutbox"("attachmentId");

-- AddForeignKey
ALTER TABLE "MessageOutbox" ADD CONSTRAINT "MessageOutbox_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "MessageAttachment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceVersionDocument" ADD CONSTRAINT "InvoiceVersionDocument_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceVersionDocument" ADD CONSTRAINT "InvoiceVersionDocument_invoiceVersionId_fkey" FOREIGN KEY ("invoiceVersionId") REFERENCES "InvoiceVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceVersionDocument" ADD CONSTRAINT "InvoiceVersionDocument_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "MessageAttachment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceDelivery" ADD CONSTRAINT "InvoiceDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceDelivery" ADD CONSTRAINT "InvoiceDelivery_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceDelivery" ADD CONSTRAINT "InvoiceDelivery_invoiceVersionId_fkey" FOREIGN KEY ("invoiceVersionId") REFERENCES "InvoiceVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceDelivery" ADD CONSTRAINT "InvoiceDelivery_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "InvoiceVersionDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceDelivery" ADD CONSTRAINT "InvoiceDelivery_sentByUserId_fkey" FOREIGN KEY ("sentByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceDeliveryRecipient" ADD CONSTRAINT "InvoiceDeliveryRecipient_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "InvoiceDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceDeliveryRecipient" ADD CONSTRAINT "InvoiceDeliveryRecipient_messageOutboxId_fkey" FOREIGN KEY ("messageOutboxId") REFERENCES "MessageOutbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceArPosting" ADD CONSTRAINT "InvoiceArPosting_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceArPosting" ADD CONSTRAINT "InvoiceArPosting_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceArPosting" ADD CONSTRAINT "InvoiceArPosting_invoiceVersionId_fkey" FOREIGN KEY ("invoiceVersionId") REFERENCES "InvoiceVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceArPosting" ADD CONSTRAINT "InvoiceArPosting_correctsPostingId_fkey" FOREIGN KEY ("correctsPostingId") REFERENCES "InvoiceArPosting"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceArPosting" ADD CONSTRAINT "InvoiceArPosting_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_invoiceVersionId_fkey" FOREIGN KEY ("invoiceVersionId") REFERENCES "InvoiceVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_receivableId_fkey" FOREIGN KEY ("receivableId") REFERENCES "InvoiceReceivable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_reversesPaymentId_fkey" FOREIGN KEY ("reversesPaymentId") REFERENCES "InvoicePayment"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------
-- #168 guards. Additive only. Everything below is append-only: a row is inserted once and never
-- rewritten or deleted, except by the foreign-key actions that follow a user deleted (the actor
-- column clearing itself) or an event deleted (the rows going with it, pg_trigger_depth() > 1).
-- ---------------------------------------------------------------------------------------------

-- A stored attachment: its size and hash are those of its content, and it is never rewritten.
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_shape" CHECK (
  length(btrim("filename")) > 0
  AND "sizeBytes" = octet_length("content")
  AND "sizeBytes" > 0
  AND "sha256" = encode(sha256("content"), 'hex')
);
CREATE FUNCTION "MessageAttachment_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 AND OLD."eventId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Event" WHERE "id" = OLD."eventId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'A message attachment is never deleted.' USING ERRCODE = '23001';
  END IF;
  RAISE EXCEPTION 'A message attachment is not rewritten.' USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "MessageAttachment_guard" BEFORE UPDATE OR DELETE ON "MessageAttachment" FOR EACH ROW EXECUTE FUNCTION "MessageAttachment_guard"();

-- The PDF of a finalized (or since superseded) version: one per version, holding exactly the attachment's hash.
ALTER TABLE "InvoiceVersionDocument" ADD CONSTRAINT "InvoiceVersionDocument_shape" CHECK ("generatorVersion" >= 1 AND "sha256" ~ '^[0-9a-f]{64}$');
CREATE FUNCTION "InvoiceVersionDocument_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "InvoiceVersion"
      WHERE "id" = NEW."invoiceVersionId" AND "invoiceId" = NEW."invoiceId" AND "eventId" = NEW."eventId" AND "status" IN ('FINALIZED', 'SUPERSEDED')
    ) THEN
      RAISE EXCEPTION 'An invoice document is made only from a finalized invoice version.' USING ERRCODE = '23001';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "MessageAttachment" WHERE "id" = NEW."attachmentId" AND "sha256" = NEW."sha256" AND "eventId" = NEW."eventId"
    ) THEN
      RAISE EXCEPTION 'An invoice document holds exactly its attachment.' USING ERRCODE = '23001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 AND NOT EXISTS (SELECT 1 FROM "Event" WHERE "id" = OLD."eventId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'An invoice document is never deleted.' USING ERRCODE = '23001';
  END IF;
  RAISE EXCEPTION 'An invoice document is not rewritten.' USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "InvoiceVersionDocument_guard" BEFORE INSERT OR UPDATE OR DELETE ON "InvoiceVersionDocument" FOR EACH ROW EXECUTE FUNCTION "InvoiceVersionDocument_guard"();

-- A send: only of a FINALIZED version (never a superseded one), with that version's document.
ALTER TABLE "InvoiceDelivery" ADD CONSTRAINT "InvoiceDelivery_shape" CHECK ("sequence" >= 1);
CREATE FUNCTION "InvoiceDelivery_guard"() RETURNS trigger AS $$
DECLARE
  new_json jsonb;
  old_json jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "InvoiceVersion"
      WHERE "id" = NEW."invoiceVersionId" AND "invoiceId" = NEW."invoiceId" AND "eventId" = NEW."eventId" AND "status" = 'FINALIZED'
    ) THEN
      RAISE EXCEPTION 'Only a finalized invoice version can be sent; a superseded version cannot.' USING ERRCODE = '23001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "InvoiceVersionDocument" WHERE "id" = NEW."documentId" AND "invoiceVersionId" = NEW."invoiceVersionId") THEN
      RAISE EXCEPTION 'A send carries its own version''s document.' USING ERRCODE = '23001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 AND NOT EXISTS (SELECT 1 FROM "Event" WHERE "id" = OLD."eventId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'An invoice delivery record is never deleted.' USING ERRCODE = '23001';
  END IF;
  old_json := to_jsonb(OLD);
  new_json := to_jsonb(NEW);
  IF pg_trigger_depth() > 1 AND NEW."sentByUserId" IS NULL AND (new_json - 'sentByUserId') = (old_json - 'sentByUserId') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'An invoice delivery record is not rewritten.' USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "InvoiceDelivery_guard" BEFORE INSERT OR UPDATE OR DELETE ON "InvoiceDelivery" FOR EACH ROW EXECUTE FUNCTION "InvoiceDelivery_guard"();

CREATE FUNCTION "InvoiceDeliveryRecipient_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- Only with its delivery, or with the event whose message it points at (the outbox row goes with the event).
    IF pg_trigger_depth() > 1 AND (
      NOT EXISTS (SELECT 1 FROM "InvoiceDelivery" WHERE "id" = OLD."deliveryId")
      OR NOT EXISTS (SELECT 1 FROM "InvoiceDelivery" d JOIN "Event" e ON e."id" = d."eventId" WHERE d."id" = OLD."deliveryId")
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'An invoice delivery recipient is never deleted.' USING ERRCODE = '23001';
  END IF;
  RAISE EXCEPTION 'An invoice delivery recipient is not rewritten.' USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "InvoiceDeliveryRecipient_guard" BEFORE INSERT OR UPDATE OR DELETE ON "InvoiceDeliveryRecipient" FOR EACH ROW EXECUTE FUNCTION "InvoiceDeliveryRecipient_guard"();

-- "Posted to AR": one root posting per finalized version; a correction is a new row naming the latest
-- posting of the same version and giving a reason. Nothing is edited or deleted.
CREATE UNIQUE INDEX "InvoiceArPosting_one_root_per_version" ON "InvoiceArPosting"("invoiceVersionId") WHERE "correctsPostingId" IS NULL;
ALTER TABLE "InvoiceArPosting" ADD CONSTRAINT "InvoiceArPosting_shape" CHECK (
  ("correctsPostingId" IS NULL AND "reason" IS NULL)
  OR ("correctsPostingId" IS NOT NULL AND "reason" IS NOT NULL AND length(btrim("reason")) > 0)
);
CREATE FUNCTION "InvoiceArPosting_guard"() RETURNS trigger AS $$
DECLARE
  new_json jsonb;
  old_json jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "InvoiceVersion"
      WHERE "id" = NEW."invoiceVersionId" AND "invoiceId" = NEW."invoiceId" AND "eventId" = NEW."eventId" AND "status" = 'FINALIZED'
    ) THEN
      RAISE EXCEPTION 'Only a finalized invoice version is posted to AR.' USING ERRCODE = '23001';
    END IF;
    IF NEW."correctsPostingId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "InvoiceArPosting" WHERE "id" = NEW."correctsPostingId" AND "invoiceVersionId" = NEW."invoiceVersionId"
    ) THEN
      RAISE EXCEPTION 'A correction names a posting of the same invoice version.' USING ERRCODE = '23001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 AND NOT EXISTS (SELECT 1 FROM "Event" WHERE "id" = OLD."eventId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'An AR posting is never deleted.' USING ERRCODE = '23001';
  END IF;
  old_json := to_jsonb(OLD);
  new_json := to_jsonb(NEW);
  IF pg_trigger_depth() > 1 AND NEW."recordedByUserId" IS NULL AND (new_json - 'recordedByUserId') = (old_json - 'recordedByUserId') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'An AR posting is not rewritten; correct it with a new posting.' USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "InvoiceArPosting_guard" BEFORE INSERT OR UPDATE OR DELETE ON "InvoiceArPosting" FOR EACH ROW EXECUTE FUNCTION "InvoiceArPosting_guard"();

-- Payments: a PAYMENT is recorded against the OPEN receivable of a FINALIZED version for more than zero; a
-- REVERSAL names one payment of the same invoice (once, unique), repeats its amount and version, and gives a
-- reason. Nothing is edited or deleted.
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_shape" CHECK (
  "amountCents" > 0
  AND (
    ("kind" = 'PAYMENT' AND "reversesPaymentId" IS NULL AND "reason" IS NULL)
    OR ("kind" = 'REVERSAL' AND "reversesPaymentId" IS NOT NULL AND "reason" IS NOT NULL AND length(btrim("reason")) > 0)
  )
);
CREATE FUNCTION "InvoicePayment_guard"() RETURNS trigger AS $$
DECLARE
  new_json jsonb;
  old_json jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'PAYMENT' THEN
      IF NOT EXISTS (
        SELECT 1 FROM "InvoiceReceivable" r JOIN "InvoiceVersion" v ON v."id" = r."invoiceVersionId"
        WHERE r."id" = NEW."receivableId" AND r."invoiceVersionId" = NEW."invoiceVersionId" AND r."invoiceId" = NEW."invoiceId" AND r."eventId" = NEW."eventId"
          AND r."status" = 'OPEN' AND v."status" = 'FINALIZED'
      ) THEN
        RAISE EXCEPTION 'A payment is recorded against the open receivable of a finalized invoice version.' USING ERRCODE = '23001';
      END IF;
    ELSE
      IF NOT EXISTS (
        SELECT 1 FROM "InvoicePayment"
        WHERE "id" = NEW."reversesPaymentId" AND "kind" = 'PAYMENT' AND "invoiceId" = NEW."invoiceId" AND "eventId" = NEW."eventId"
          AND "invoiceVersionId" = NEW."invoiceVersionId" AND "receivableId" = NEW."receivableId" AND "amountCents" = NEW."amountCents"
      ) THEN
        RAISE EXCEPTION 'A reversal repeats the payment it voids.' USING ERRCODE = '23001';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 AND NOT EXISTS (SELECT 1 FROM "Event" WHERE "id" = OLD."eventId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'A payment entry is never deleted.' USING ERRCODE = '23001';
  END IF;
  old_json := to_jsonb(OLD);
  new_json := to_jsonb(NEW);
  IF pg_trigger_depth() > 1 AND NEW."recordedByUserId" IS NULL AND (new_json - 'recordedByUserId') = (old_json - 'recordedByUserId') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A payment entry is not rewritten; void it with a reversal.' USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "InvoicePayment_guard" BEFORE INSERT OR UPDATE OR DELETE ON "InvoicePayment" FOR EACH ROW EXECUTE FUNCTION "InvoicePayment_guard"();
