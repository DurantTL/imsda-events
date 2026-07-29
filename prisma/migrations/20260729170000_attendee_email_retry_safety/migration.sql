-- Make attendee email preparation retry-safe and give delivered codes their
-- advertised lifetime even when a message waited in the outbox.
ALTER TABLE "AttendeeAccountToken"
ADD COLUMN "deliveryMessageId" TEXT,
ADD COLUMN "sealedCode" TEXT,
ADD COLUMN "codeExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "AttendeeAccountToken_deliveryMessageId_key"
ON "AttendeeAccountToken"("deliveryMessageId");

CREATE INDEX "AttendeeAccountToken_codeExpiresAt_idx"
ON "AttendeeAccountToken"("codeExpiresAt");
