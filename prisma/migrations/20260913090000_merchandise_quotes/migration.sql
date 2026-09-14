-- Add authoritative, expiring merchandise quotes and logical inventory
-- reservations. No catalog is activated and no existing price is changed.
CREATE TYPE "MerchandiseQuoteStatus" AS ENUM (
  'ACTIVE',
  'PAYMENT_PENDING',
  'RELEASED',
  'COMPLETED'
);

CREATE TYPE "MerchandiseQuotePaymentMethod" AS ENUM (
  'CARD',
  'CASH',
  'CHECK'
);

CREATE TYPE "MerchandiseReservationReleaseReason" AS ENUM (
  'EXPIRED',
  'FAILED_PAYMENT',
  'CANCELLED_PAYMENT',
  'ABANDONED',
  'STALE_CATALOG'
);

ALTER TABLE "MerchandiseCatalog"
  ADD COLUMN "taxRateBasisPoints" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cardFeePercentageBasisPoints" INTEGER NOT NULL DEFAULT 290,
  ADD COLUMN "cardFeeFixedCents" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "quoteTtlMinutes" INTEGER NOT NULL DEFAULT 15,
  ADD CONSTRAINT "MerchandiseCatalog_quote_policy_check" CHECK (
    "taxRateBasisPoints" BETWEEN 0 AND 10000
    AND "cardFeePercentageBasisPoints" BETWEEN 0 AND 2000
    AND "cardFeeFixedCents" BETWEEN 0 AND 1000
    AND "quoteTtlMinutes" BETWEEN 1 AND 1440
  );

CREATE TABLE "MerchandiseQuote" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "registrationId" TEXT,
  "actorUserId" TEXT,
  "purchaserSnapshot" JSONB NOT NULL,
  "clientRequestId" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "catalogFingerprint" TEXT NOT NULL,
  "paymentIdempotencyKey" TEXT NOT NULL,
  "status" "MerchandiseQuoteStatus" NOT NULL DEFAULT 'ACTIVE',
  "paymentMethod" "MerchandiseQuotePaymentMethod" NOT NULL,
  "eligibilitySnapshot" TEXT NOT NULL,
  "subtotalCents" INTEGER NOT NULL,
  "taxCents" INTEGER NOT NULL DEFAULT 0,
  "feeCents" INTEGER NOT NULL DEFAULT 0,
  "totalCents" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "releasedAt" TIMESTAMP(3),
  "releaseReason" "MerchandiseReservationReleaseReason",
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MerchandiseQuote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MerchandiseQuote_amounts_check" CHECK (
    "subtotalCents" >= 0
    AND "taxCents" >= 0
    AND "feeCents" >= 0
    AND "totalCents" = "subtotalCents" + "taxCents" + "feeCents"
  ),
  CONSTRAINT "MerchandiseQuote_release_state_check" CHECK (
    ("status" = 'RELEASED' AND "releasedAt" IS NOT NULL AND "releaseReason" IS NOT NULL AND "completedAt" IS NULL)
    OR ("status" = 'COMPLETED' AND "completedAt" IS NOT NULL AND "releasedAt" IS NULL AND "releaseReason" IS NULL)
    OR ("status" IN ('ACTIVE', 'PAYMENT_PENDING') AND "releasedAt" IS NULL AND "releaseReason" IS NULL AND "completedAt" IS NULL)
  )
);

CREATE TABLE "MerchandiseQuoteLine" (
  "id" TEXT NOT NULL,
  "quoteId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "productId" TEXT,
  "productNameSnapshot" TEXT NOT NULL,
  "variantId" TEXT,
  "variantLabelSnapshot" TEXT NOT NULL,
  "availabilityId" TEXT,
  "unitPriceCentsSnapshot" INTEGER NOT NULL,
  "quantity" INTEGER NOT NULL,
  "taxTreatmentSnapshot" "MerchandiseTaxTreatment" NOT NULL,
  "feePolicySnapshot" "MerchandiseFeePolicy" NOT NULL,
  "lineSubtotalCents" INTEGER NOT NULL,
  "lineTaxCents" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MerchandiseQuoteLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MerchandiseQuoteLine_amounts_check" CHECK (
    "unitPriceCentsSnapshot" >= 0
    AND "quantity" > 0
    AND "lineSubtotalCents" = "unitPriceCentsSnapshot" * "quantity"
    AND "lineTaxCents" >= 0
  )
);

CREATE TABLE "MerchandiseInventoryReservation" (
  "id" TEXT NOT NULL,
  "quoteId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "variantId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "releasedAt" TIMESTAMP(3),
  "releaseReason" "MerchandiseReservationReleaseReason",
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MerchandiseInventoryReservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MerchandiseInventoryReservation_state_check" CHECK (
    "quantity" > 0
    AND NOT ("releasedAt" IS NOT NULL AND "completedAt" IS NOT NULL)
    AND (("releasedAt" IS NULL) = ("releaseReason" IS NULL))
  )
);

CREATE UNIQUE INDEX "MerchandiseQuote_paymentIdempotencyKey_key"
  ON "MerchandiseQuote"("paymentIdempotencyKey");
CREATE UNIQUE INDEX "MerchandiseQuote_eventId_clientRequestId_key"
  ON "MerchandiseQuote"("eventId", "clientRequestId");
CREATE INDEX "MerchandiseQuote_eventId_status_expiresAt_idx"
  ON "MerchandiseQuote"("eventId", "status", "expiresAt");
CREATE INDEX "MerchandiseQuote_registrationId_createdAt_idx"
  ON "MerchandiseQuote"("registrationId", "createdAt");
CREATE UNIQUE INDEX "MerchandiseQuoteLine_quoteId_variantId_key"
  ON "MerchandiseQuoteLine"("quoteId", "variantId");
CREATE INDEX "MerchandiseQuoteLine_eventId_createdAt_idx"
  ON "MerchandiseQuoteLine"("eventId", "createdAt");
CREATE INDEX "MerchandiseQuoteLine_variantId_idx"
  ON "MerchandiseQuoteLine"("variantId");
CREATE UNIQUE INDEX "MerchandiseInventoryReservation_quoteId_variantId_key"
  ON "MerchandiseInventoryReservation"("quoteId", "variantId");
CREATE INDEX "MerchandiseInventoryReservation_variantId_releasedAt_expiresAt_idx"
  ON "MerchandiseInventoryReservation"("variantId", "releasedAt", "expiresAt");
CREATE INDEX "MerchandiseInventoryReservation_eventId_releasedAt_expiresAt_idx"
  ON "MerchandiseInventoryReservation"("eventId", "releasedAt", "expiresAt");

ALTER TABLE "MerchandiseQuote" ADD CONSTRAINT "MerchandiseQuote_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MerchandiseQuote" ADD CONSTRAINT "MerchandiseQuote_registrationId_fkey"
  FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MerchandiseQuote" ADD CONSTRAINT "MerchandiseQuote_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MerchandiseQuoteLine" ADD CONSTRAINT "MerchandiseQuoteLine_quoteId_fkey"
  FOREIGN KEY ("quoteId") REFERENCES "MerchandiseQuote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MerchandiseQuoteLine" ADD CONSTRAINT "MerchandiseQuoteLine_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MerchandiseQuoteLine" ADD CONSTRAINT "MerchandiseQuoteLine_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "MerchandiseProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MerchandiseQuoteLine" ADD CONSTRAINT "MerchandiseQuoteLine_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "MerchandiseProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MerchandiseQuoteLine" ADD CONSTRAINT "MerchandiseQuoteLine_availabilityId_fkey"
  FOREIGN KEY ("availabilityId") REFERENCES "MerchandiseVariantAvailability"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MerchandiseInventoryReservation" ADD CONSTRAINT "MerchandiseInventoryReservation_quoteId_fkey"
  FOREIGN KEY ("quoteId") REFERENCES "MerchandiseQuote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MerchandiseInventoryReservation" ADD CONSTRAINT "MerchandiseInventoryReservation_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MerchandiseInventoryReservation" ADD CONSTRAINT "MerchandiseInventoryReservation_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "MerchandiseProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
