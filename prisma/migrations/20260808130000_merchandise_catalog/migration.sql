-- Event-admin merchandise catalog configuration. Additive only: order ledger
-- snapshots remain immutable and no live sales are activated by this migration.
CREATE TYPE "MerchandiseCatalogStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED');

CREATE TABLE "MerchandiseCatalog" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "isEnabled" BOOLEAN NOT NULL DEFAULT false,
  "status" "MerchandiseCatalogStatus" NOT NULL DEFAULT 'DRAFT',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MerchandiseCatalog_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MerchandiseCatalog_eventId_key" UNIQUE ("eventId")
);

ALTER TABLE "MerchandiseProduct"
  ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "artworkAssetId" TEXT,
  ADD COLUMN "artworkAltText" TEXT;

ALTER TABLE "MerchandiseProductVariant"
  ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "MerchandiseVariantAvailability"
  ADD COLUMN "salesStartsAt" TIMESTAMP(3),
  ADD COLUMN "salesEndsAt" TIMESTAMP(3),
  ADD COLUMN "minQuantity" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "maxQuantity" INTEGER,
  ADD COLUMN "attendeeAvailability" TEXT NOT NULL DEFAULT 'ALL';

ALTER TABLE "MerchandiseProduct"
  ADD CONSTRAINT "MerchandiseProduct_archive_requires_disabled"
  CHECK (NOT "isArchived" OR NOT "isEnabled"),
  ADD CONSTRAINT "MerchandiseProduct_position_nonnegative"
  CHECK ("position" >= 0),
  ADD CONSTRAINT "MerchandiseProduct_artwork_alt_text_pair"
  -- Postgres treats a CHECK expression that evaluates to NULL as satisfied,
  -- not violated. Without an explicit "artworkAltText" IS NOT NULL conjunct, a
  -- row with an assetId but a NULL altText makes the second branch evaluate
  -- to NULL (length(trim(NULL)) is NULL) rather than FALSE, and the whole OR
  -- silently passes. The explicit IS NOT NULL forces that branch to FALSE.
  CHECK (("artworkAssetId" IS NULL AND "artworkAltText" IS NULL) OR ("artworkAssetId" IS NOT NULL AND "artworkAltText" IS NOT NULL AND length(trim("artworkAltText")) >= 3));

ALTER TABLE "MerchandiseProductVariant"
  ADD CONSTRAINT "MerchandiseProductVariant_archive_requires_disabled"
  CHECK (NOT "isArchived" OR NOT "isEnabled"),
  ADD CONSTRAINT "MerchandiseProductVariant_position_nonnegative"
  CHECK ("position" >= 0);

ALTER TABLE "MerchandiseVariantAvailability"
  ADD CONSTRAINT "MerchandiseVariantAvailability_price_nonnegative"
  CHECK ("priceCents" >= 0),
  ADD CONSTRAINT "MerchandiseVariantAvailability_quantity_bounds"
  CHECK ("minQuantity" >= 1 AND ("maxQuantity" IS NULL OR "maxQuantity" >= "minQuantity")),
  ADD CONSTRAINT "MerchandiseVariantAvailability_sales_window_order"
  CHECK ("salesStartsAt" IS NULL OR "salesEndsAt" IS NULL OR "salesEndsAt" >= "salesStartsAt"),
  ADD CONSTRAINT "MerchandiseVariantAvailability_attendee_availability"
  CHECK ("attendeeAvailability" IN ('ALL', 'REGISTERED', 'STAFF_ONLY'));

ALTER TABLE "MerchandiseCatalog"
  ADD CONSTRAINT "MerchandiseCatalog_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MerchandiseProduct"
  ADD CONSTRAINT "MerchandiseProduct_artworkAssetId_fkey"
  FOREIGN KEY ("artworkAssetId") REFERENCES "EventAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "MerchandiseProduct_eventId_isEnabled_isArchived_position_idx"
  ON "MerchandiseProduct"("eventId", "isEnabled", "isArchived", "position");
CREATE INDEX "MerchandiseVariantAvailability_sales_window_idx"
  ON "MerchandiseVariantAvailability"("variantId", "isActive", "salesStartsAt", "salesEndsAt");
