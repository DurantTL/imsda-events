CREATE TYPE "PromoDiscountType" AS ENUM ('FIXED_CENTS', 'PERCENT_BPS');

CREATE TABLE "PromoCode" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "normalizedCode" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "discountType" "PromoDiscountType" NOT NULL,
    "discountValue" INTEGER NOT NULL,
    "startsOn" TEXT,
    "endsOn" TEXT,
    "minimumSubtotalCents" INTEGER,
    "maximumUses" INTEGER,
    "maximumDiscountCents" INTEGER,
    "redeemedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromoCode_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PromoCode_discountValue_positive" CHECK ("discountValue" > 0),
    CONSTRAINT "PromoCode_redeemedCount_nonnegative" CHECK ("redeemedCount" >= 0),
    CONSTRAINT "PromoCode_minimumSubtotal_nonnegative" CHECK ("minimumSubtotalCents" IS NULL OR "minimumSubtotalCents" >= 0),
    CONSTRAINT "PromoCode_maximumUses_positive" CHECK ("maximumUses" IS NULL OR "maximumUses" > 0),
    CONSTRAINT "PromoCode_maximumDiscount_positive" CHECK ("maximumDiscountCents" IS NULL OR "maximumDiscountCents" > 0),
    CONSTRAINT "PromoCode_percent_range" CHECK ("discountType" <> 'PERCENT_BPS' OR "discountValue" <= 10000),
    CONSTRAINT "PromoCode_fixed_has_no_percent_cap" CHECK ("discountType" <> 'FIXED_CENTS' OR "maximumDiscountCents" IS NULL),
    CONSTRAINT "PromoCode_date_order" CHECK ("startsOn" IS NULL OR "endsOn" IS NULL OR "startsOn" <= "endsOn"),
    CONSTRAINT "PromoCode_code_normalized" CHECK ("normalizedCode" = upper(btrim("normalizedCode"))),
    CONSTRAINT "PromoCode_redemptions_within_limit" CHECK ("maximumUses" IS NULL OR "redeemedCount" <= "maximumUses")
);

CREATE TABLE "PromoCodeRedemption" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "promoCodeId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "codeSnapshot" TEXT NOT NULL,
    "discountTypeSnapshot" "PromoDiscountType" NOT NULL,
    "discountValueSnapshot" INTEGER NOT NULL,
    "startsOnSnapshot" TEXT,
    "endsOnSnapshot" TEXT,
    "minimumSubtotalCentsSnapshot" INTEGER,
    "maximumUsesSnapshot" INTEGER,
    "maximumDiscountCentsSnapshot" INTEGER,
    "eligibleSubtotalCents" INTEGER NOT NULL,
    "discountAmountCents" INTEGER NOT NULL,
    "pricingDate" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromoCodeRedemption_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PromoCodeRedemption_eligible_nonnegative" CHECK ("eligibleSubtotalCents" >= 0),
    CONSTRAINT "PromoCodeRedemption_discount_nonnegative" CHECK ("discountAmountCents" >= 0),
    CONSTRAINT "PromoCodeRedemption_discount_bounded" CHECK ("discountAmountCents" <= "eligibleSubtotalCents")
);

CREATE UNIQUE INDEX "PromoCode_eventId_normalizedCode_key"
ON "PromoCode"("eventId", "normalizedCode");

CREATE INDEX "PromoCode_eventId_isActive_updatedAt_idx"
ON "PromoCode"("eventId", "isActive", "updatedAt");

CREATE UNIQUE INDEX "PromoCodeRedemption_registrationId_key"
ON "PromoCodeRedemption"("registrationId");

CREATE UNIQUE INDEX "PromoCodeRedemption_promoCodeId_registrationId_key"
ON "PromoCodeRedemption"("promoCodeId", "registrationId");

CREATE INDEX "PromoCodeRedemption_eventId_createdAt_idx"
ON "PromoCodeRedemption"("eventId", "createdAt");

CREATE INDEX "PromoCodeRedemption_promoCodeId_createdAt_idx"
ON "PromoCodeRedemption"("promoCodeId", "createdAt");

ALTER TABLE "PromoCode"
ADD CONSTRAINT "PromoCode_eventId_fkey"
FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PromoCodeRedemption"
ADD CONSTRAINT "PromoCodeRedemption_eventId_fkey"
FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PromoCodeRedemption"
ADD CONSTRAINT "PromoCodeRedemption_promoCodeId_fkey"
FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PromoCodeRedemption"
ADD CONSTRAINT "PromoCodeRedemption_registrationId_fkey"
FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
