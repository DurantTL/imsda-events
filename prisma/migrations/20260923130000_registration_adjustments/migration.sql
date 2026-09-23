-- Staff adjustments to what a registration owes (#396).
-- CreateEnum
CREATE TYPE "RegistrationAdjustmentKind" AS ENUM ('SCHOLARSHIP', 'DISCOUNT', 'PROMO_CODE', 'CORRECTION');

-- CreateTable
CREATE TABLE "RegistrationAdjustment" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "kind" "RegistrationAdjustmentKind" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "promoCodeId" TEXT,
    "promoCodeSnapshot" TEXT,
    "reversesAdjustmentId" TEXT,
    "createdByUserId" TEXT,
    "createdByNameSnapshot" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "RegistrationAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationAdjustment_reversesAdjustmentId_key" ON "RegistrationAdjustment"("reversesAdjustmentId");

-- CreateIndex
CREATE INDEX "RegistrationAdjustment_registrationId_createdAt_idx" ON "RegistrationAdjustment"("registrationId", "createdAt");

-- CreateIndex
CREATE INDEX "RegistrationAdjustment_eventId_kind_idx" ON "RegistrationAdjustment"("eventId", "kind");

-- AddForeignKey
ALTER TABLE "RegistrationAdjustment" ADD CONSTRAINT "RegistrationAdjustment_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationAdjustment" ADD CONSTRAINT "RegistrationAdjustment_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationAdjustment" ADD CONSTRAINT "RegistrationAdjustment_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationAdjustment" ADD CONSTRAINT "RegistrationAdjustment_reversesAdjustmentId_fkey" FOREIGN KEY ("reversesAdjustmentId") REFERENCES "RegistrationAdjustment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
