-- Square card data and raw webhook payloads are deliberately excluded. These
-- records retain only server quotes, idempotency keys, provider object IDs,
-- status, and a SHA-256 payload digest for auditability.
CREATE TYPE "PaymentAttemptStatus" AS ENUM (
  'PROCESSING',
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'CANCELED'
);

CREATE TYPE "SquareWebhookEventStatus" AS ENUM (
  'PROCESSED',
  'IGNORED'
);

CREATE TABLE "PaymentAttempt" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "registrationId" TEXT NOT NULL,
  "registrationAccessTokenId" TEXT,
  "paymentId" TEXT,
  "provider" TEXT NOT NULL DEFAULT 'SQUARE',
  "environment" TEXT NOT NULL,
  "clientIdempotencyKey" TEXT NOT NULL,
  "providerIdempotencyKey" TEXT NOT NULL,
  "activeRegistrationKey" TEXT,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "status" "PaymentAttemptStatus" NOT NULL DEFAULT 'PROCESSING',
  "providerPaymentId" TEXT,
  "providerStatus" TEXT,
  "providerStatusAt" TIMESTAMP(3),
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "requestCount" INTEGER NOT NULL DEFAULT 1,
  "lastRequestedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentAttempt_amountCents_positive" CHECK ("amountCents" > 0),
  CONSTRAINT "PaymentAttempt_requestCount_positive" CHECK ("requestCount" > 0)
);

CREATE TABLE "SquareWebhookEvent" (
  "id" TEXT NOT NULL,
  "eventId" TEXT,
  "paymentAttemptId" TEXT,
  "providerEventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "objectId" TEXT,
  "payloadHash" TEXT NOT NULL,
  "status" "SquareWebhookEventStatus" NOT NULL,
  "reason" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SquareWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentAttempt_paymentId_key"
ON "PaymentAttempt"("paymentId");

CREATE UNIQUE INDEX "PaymentAttempt_clientIdempotencyKey_key"
ON "PaymentAttempt"("clientIdempotencyKey");

CREATE UNIQUE INDEX "PaymentAttempt_providerIdempotencyKey_key"
ON "PaymentAttempt"("providerIdempotencyKey");

-- A non-null value is held while Square is processing or has a pending
-- payment. This prevents two browser tabs from opening concurrent charges for
-- the same registration while retaining every terminal attempt.
CREATE UNIQUE INDEX "PaymentAttempt_activeRegistrationKey_key"
ON "PaymentAttempt"("activeRegistrationKey");

CREATE UNIQUE INDEX "PaymentAttempt_providerPaymentId_key"
ON "PaymentAttempt"("providerPaymentId");

CREATE INDEX "PaymentAttempt_eventId_status_createdAt_idx"
ON "PaymentAttempt"("eventId", "status", "createdAt");

CREATE INDEX "PaymentAttempt_registrationId_createdAt_idx"
ON "PaymentAttempt"("registrationId", "createdAt");

CREATE UNIQUE INDEX "SquareWebhookEvent_providerEventId_key"
ON "SquareWebhookEvent"("providerEventId");

CREATE INDEX "SquareWebhookEvent_eventType_objectId_occurredAt_idx"
ON "SquareWebhookEvent"("eventType", "objectId", "occurredAt");

CREATE INDEX "SquareWebhookEvent_paymentAttemptId_occurredAt_idx"
ON "SquareWebhookEvent"("paymentAttemptId", "occurredAt");

CREATE INDEX "SquareWebhookEvent_eventId_occurredAt_idx"
ON "SquareWebhookEvent"("eventId", "occurredAt");

CREATE UNIQUE INDEX "Refund_paymentId_externalReference_key"
ON "Refund"("paymentId", "externalReference");

ALTER TABLE "PaymentAttempt"
ADD CONSTRAINT "PaymentAttempt_eventId_fkey"
FOREIGN KEY ("eventId") REFERENCES "Event"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PaymentAttempt"
ADD CONSTRAINT "PaymentAttempt_registrationId_fkey"
FOREIGN KEY ("registrationId") REFERENCES "Registration"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PaymentAttempt"
ADD CONSTRAINT "PaymentAttempt_registrationAccessTokenId_fkey"
FOREIGN KEY ("registrationAccessTokenId") REFERENCES "RegistrationAccessToken"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PaymentAttempt"
ADD CONSTRAINT "PaymentAttempt_paymentId_fkey"
FOREIGN KEY ("paymentId") REFERENCES "Payment"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SquareWebhookEvent"
ADD CONSTRAINT "SquareWebhookEvent_eventId_fkey"
FOREIGN KEY ("eventId") REFERENCES "Event"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SquareWebhookEvent"
ADD CONSTRAINT "SquareWebhookEvent_paymentAttemptId_fkey"
FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
