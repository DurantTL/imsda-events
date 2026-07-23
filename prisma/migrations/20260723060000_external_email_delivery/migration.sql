ALTER TYPE "MessageDeliveryMode" ADD VALUE 'EXTERNAL_EMAIL';

CREATE TYPE "MessageProviderDeliveryStatus" AS ENUM (
    'ACCEPTED',
    'SENT',
    'DELIVERED',
    'BOUNCED',
    'FAILED',
    'COMPLAINED',
    'SUPPRESSED'
);

ALTER TABLE "MessageOutbox"
    ADD COLUMN "provider" TEXT,
    ADD COLUMN "providerMessageId" TEXT,
    ADD COLUMN "providerDeliveryStatus" "MessageProviderDeliveryStatus",
    ADD COLUMN "providerStatusAt" TIMESTAMP(3),
    ADD COLUMN "deliveredAt" TIMESTAMP(3),
    ADD COLUMN "failedAt" TIMESTAMP(3);

CREATE TABLE "MessageProviderEvent" (
    "id" TEXT NOT NULL,
    "messageOutboxId" TEXT,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "mappedDeliveryStatus" "MessageProviderDeliveryStatus",
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MessageProviderEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MessageOutbox_providerMessageId_key"
    ON "MessageOutbox"("providerMessageId");
CREATE INDEX "MessageOutbox_provider_providerDeliveryStatus_providerStatusAt_idx"
    ON "MessageOutbox"("provider", "providerDeliveryStatus", "providerStatusAt");
CREATE UNIQUE INDEX "MessageProviderEvent_provider_providerEventId_key"
    ON "MessageProviderEvent"("provider", "providerEventId");
CREATE INDEX "MessageProviderEvent_provider_providerMessageId_occurredAt_idx"
    ON "MessageProviderEvent"("provider", "providerMessageId", "occurredAt");
CREATE INDEX "MessageProviderEvent_messageOutboxId_occurredAt_idx"
    ON "MessageProviderEvent"("messageOutboxId", "occurredAt");

ALTER TABLE "MessageProviderEvent" ADD CONSTRAINT "MessageProviderEvent_messageOutboxId_fkey"
    FOREIGN KEY ("messageOutboxId") REFERENCES "MessageOutbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;
