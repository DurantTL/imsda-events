-- Additive foundation for event merchandise. This migration creates no catalog
-- rows and does not alter registration totals, payments, or refunds.
CREATE TYPE "MerchandiseOrderStatus" AS ENUM (
  'PENDING',
  'PAID',
  'CANCELLED',
  'REFUNDED'
);

CREATE TYPE "MerchandiseInventoryPolicy" AS ENUM (
  'UNLIMITED',
  'TRACKED'
);

CREATE TYPE "MerchandiseTaxTreatment" AS ENUM (
  'TAXABLE',
  'TAX_EXEMPT'
);

CREATE TYPE "MerchandiseFeePolicy" AS ENUM (
  'ABSORBED_BY_EVENT',
  'PASSED_TO_BUYER'
);

CREATE TABLE "MerchandiseProduct" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "isEnabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MerchandiseProduct_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MerchandiseProductVariant" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "sku" TEXT,
  "position" INTEGER NOT NULL DEFAULT 0,
  "isEnabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MerchandiseProductVariant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MerchandiseProductVariant_productId_label_key"
    UNIQUE ("productId", "label")
);

CREATE TABLE "MerchandiseVariantAvailability" (
  "id" TEXT NOT NULL,
  "variantId" TEXT NOT NULL,
  "versionNumber" INTEGER NOT NULL,
  "priceCents" INTEGER NOT NULL,
  "taxTreatment" "MerchandiseTaxTreatment" NOT NULL,
  "feePolicy" "MerchandiseFeePolicy" NOT NULL,
  "inventoryPolicy" "MerchandiseInventoryPolicy" NOT NULL DEFAULT 'UNLIMITED',
  "inventoryQuantity" INTEGER,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdByUserId" TEXT NOT NULL,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MerchandiseVariantAvailability_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MerchandiseVariantAvailability_variantId_versionNumber_key"
    UNIQUE ("variantId", "versionNumber"),
  CONSTRAINT "MerchandiseVariantAvailability_version_price_check"
    CHECK ("versionNumber" > 0 AND "priceCents" >= 0),
  CONSTRAINT "MerchandiseVariantAvailability_inventory_check"
    CHECK (
      ("inventoryPolicy" = 'UNLIMITED' AND "inventoryQuantity" IS NULL)
      OR
      ("inventoryPolicy" = 'TRACKED' AND "inventoryQuantity" >= 0)
    )
);

CREATE TABLE "MerchandiseOrder" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "registrationId" TEXT,
  "purchaserSnapshot" JSONB NOT NULL,
  "clientRequestId" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "status" "MerchandiseOrderStatus" NOT NULL DEFAULT 'PENDING',
  "subtotalCents" INTEGER NOT NULL,
  "feeCents" INTEGER NOT NULL DEFAULT 0,
  "taxCents" INTEGER NOT NULL DEFAULT 0,
  "totalCents" INTEGER NOT NULL,
  "paymentMethod" "PaymentMethod",
  "paymentReference" TEXT,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MerchandiseOrder_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MerchandiseOrder_eventId_clientRequestId_key"
    UNIQUE ("eventId", "clientRequestId"),
  CONSTRAINT "MerchandiseOrder_amounts_check"
    CHECK (
      "subtotalCents" >= 0
      AND "feeCents" >= 0
      AND "taxCents" >= 0
      AND "totalCents" = "subtotalCents" + "feeCents" + "taxCents"
    )
);

CREATE TABLE "MerchandiseOrderLine" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
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
  "lineTotalCents" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MerchandiseOrderLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MerchandiseOrderLine_amounts_check"
    CHECK (
      "unitPriceCentsSnapshot" >= 0
      AND "quantity" > 0
      AND "lineTotalCents" = "unitPriceCentsSnapshot" * "quantity"
    )
);

CREATE TABLE "MerchandiseOrderStatusChange" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "fromStatus" "MerchandiseOrderStatus" NOT NULL,
  "toStatus" "MerchandiseOrderStatus" NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MerchandiseOrderStatusChange_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MerchandiseOrderStatusChange_transition_check"
    CHECK ("fromStatus" <> "toStatus")
);

CREATE INDEX "MerchandiseProduct_eventId_isEnabled_idx"
  ON "MerchandiseProduct"("eventId", "isEnabled");
CREATE INDEX "MerchandiseProductVariant_productId_isEnabled_position_idx"
  ON "MerchandiseProductVariant"("productId", "isEnabled", "position");
CREATE INDEX "MerchandiseVariantAvailability_variantId_isActive_idx"
  ON "MerchandiseVariantAvailability"("variantId", "isActive");
CREATE UNIQUE INDEX "MerchandiseVariantAvailability_one_active_per_variant"
  ON "MerchandiseVariantAvailability"("variantId")
  WHERE "isActive" = true;
CREATE INDEX "MerchandiseOrder_eventId_status_createdAt_idx"
  ON "MerchandiseOrder"("eventId", "status", "createdAt");
CREATE INDEX "MerchandiseOrder_registrationId_idx"
  ON "MerchandiseOrder"("registrationId");
CREATE INDEX "MerchandiseOrderLine_orderId_idx"
  ON "MerchandiseOrderLine"("orderId");
CREATE INDEX "MerchandiseOrderLine_eventId_createdAt_idx"
  ON "MerchandiseOrderLine"("eventId", "createdAt");
CREATE INDEX "MerchandiseOrderLine_productId_idx"
  ON "MerchandiseOrderLine"("productId");
CREATE INDEX "MerchandiseOrderLine_variantId_idx"
  ON "MerchandiseOrderLine"("variantId");
CREATE INDEX "MerchandiseOrderStatusChange_orderId_createdAt_idx"
  ON "MerchandiseOrderStatusChange"("orderId", "createdAt");
CREATE INDEX "MerchandiseOrderStatusChange_eventId_createdAt_idx"
  ON "MerchandiseOrderStatusChange"("eventId", "createdAt");

ALTER TABLE "MerchandiseProduct"
  ADD CONSTRAINT "MerchandiseProduct_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MerchandiseProductVariant"
  ADD CONSTRAINT "MerchandiseProductVariant_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "MerchandiseProduct"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MerchandiseVariantAvailability"
  ADD CONSTRAINT "MerchandiseVariantAvailability_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "MerchandiseProductVariant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MerchandiseVariantAvailability"
  ADD CONSTRAINT "MerchandiseVariantAvailability_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MerchandiseOrder"
  ADD CONSTRAINT "MerchandiseOrder_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MerchandiseOrder"
  ADD CONSTRAINT "MerchandiseOrder_registrationId_fkey"
  FOREIGN KEY ("registrationId") REFERENCES "Registration"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MerchandiseOrder"
  ADD CONSTRAINT "MerchandiseOrder_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MerchandiseOrderLine"
  ADD CONSTRAINT "MerchandiseOrderLine_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "MerchandiseOrder"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MerchandiseOrderLine"
  ADD CONSTRAINT "MerchandiseOrderLine_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MerchandiseOrderLine"
  ADD CONSTRAINT "MerchandiseOrderLine_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "MerchandiseProduct"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MerchandiseOrderLine"
  ADD CONSTRAINT "MerchandiseOrderLine_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "MerchandiseProductVariant"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MerchandiseOrderLine"
  ADD CONSTRAINT "MerchandiseOrderLine_availabilityId_fkey"
  FOREIGN KEY ("availabilityId") REFERENCES "MerchandiseVariantAvailability"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MerchandiseOrderStatusChange"
  ADD CONSTRAINT "MerchandiseOrderStatusChange_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "MerchandiseOrder"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MerchandiseOrderStatusChange"
  ADD CONSTRAINT "MerchandiseOrderStatusChange_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MerchandiseOrderStatusChange"
  ADD CONSTRAINT "MerchandiseOrderStatusChange_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
