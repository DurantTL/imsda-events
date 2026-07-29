ALTER TYPE "MessageTemplateKey" ADD VALUE IF NOT EXISTS 'ATTENDEE_EDIT_VERIFICATION';

ALTER TABLE "AttendeeStepUpCode"
ALTER COLUMN "codeHash" DROP NOT NULL,
ADD COLUMN "deliveryMessageId" TEXT,
ADD COLUMN "sealedCode" TEXT,
ADD COLUMN "codeExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "AttendeeStepUpCode_deliveryMessageId_key"
ON "AttendeeStepUpCode"("deliveryMessageId");

CREATE INDEX "AttendeeStepUpCode_codeExpiresAt_idx"
ON "AttendeeStepUpCode"("codeExpiresAt");
