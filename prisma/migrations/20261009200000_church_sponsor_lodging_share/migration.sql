-- A lodging change moves a church-sponsored registration's church share automatically (#813). Additive only: one
-- column with a default on PromoCodeRedemption and one new table. Nothing existing is changed or deleted, and no
-- backfill is needed (every existing redemption has moved by 0). Matches `prisma migrate diff` against the schema.

-- AlterTable
ALTER TABLE "PromoCodeRedemption" ADD COLUMN     "sponsorLodgingChangeCents" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ChurchSponsorFinanceReview" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "churchId" TEXT NOT NULL,
    "invoiceVersionId" TEXT,
    "sourceKey" TEXT NOT NULL,
    "deltaCents" INTEGER NOT NULL,
    "desiredShareCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clearedAt" TIMESTAMP(3),
    "clearedByUserId" TEXT,
    "clearNote" TEXT,
    "reviewedShareCents" INTEGER,

    CONSTRAINT "ChurchSponsorFinanceReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChurchSponsorFinanceReview_eventId_clearedAt_idx" ON "ChurchSponsorFinanceReview"("eventId", "clearedAt");

-- CreateIndex
CREATE INDEX "ChurchSponsorFinanceReview_churchId_idx" ON "ChurchSponsorFinanceReview"("churchId");

-- CreateIndex
CREATE INDEX "ChurchSponsorFinanceReview_registrationId_clearedAt_idx" ON "ChurchSponsorFinanceReview"("registrationId", "clearedAt");

-- AddForeignKey
ALTER TABLE "ChurchSponsorFinanceReview" ADD CONSTRAINT "ChurchSponsorFinanceReview_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChurchSponsorFinanceReview" ADD CONSTRAINT "ChurchSponsorFinanceReview_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChurchSponsorFinanceReview" ADD CONSTRAINT "ChurchSponsorFinanceReview_churchId_fkey" FOREIGN KEY ("churchId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
