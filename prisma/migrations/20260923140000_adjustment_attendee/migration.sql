-- Per-person promo codes and adjustments (#397).
-- AlterTable
ALTER TABLE "RegistrationAdjustment" ADD COLUMN     "registrationAttendeeId" TEXT;

-- CreateIndex
CREATE INDEX "RegistrationAdjustment_registrationAttendeeId_idx" ON "RegistrationAdjustment"("registrationAttendeeId");

-- AddForeignKey
ALTER TABLE "RegistrationAdjustment" ADD CONSTRAINT "RegistrationAdjustment_registrationAttendeeId_fkey" FOREIGN KEY ("registrationAttendeeId") REFERENCES "RegistrationAttendee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
