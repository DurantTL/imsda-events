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
