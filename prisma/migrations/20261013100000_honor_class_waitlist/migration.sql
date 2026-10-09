-- Honors Weekend class waitlist with in-order offers (#831). Additive only: a table,
-- a status type, one Event column (the acceptance window, in hours), and one email
-- template key. Nothing existing is changed or backfilled.

-- CreateEnum
CREATE TYPE "HonorClassWaitlistStatus" AS ENUM ('WAITING', 'OFFERED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'REMOVED');

-- AlterEnum
ALTER TYPE "MessageTemplateKey" ADD VALUE 'HONOR_CLASS_WAITLIST_OFFER';

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "honorWaitlistOfferHours" INTEGER NOT NULL DEFAULT 24;

-- CreateTable
CREATE TABLE "HonorClassWaitlistEntry" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "registrationAttendeeId" TEXT NOT NULL,
    "organizationId" TEXT,
    "joinOrder" SERIAL NOT NULL,
    "status" "HonorClassWaitlistStatus" NOT NULL DEFAULT 'WAITING',
    "levelConfirmedByDirector" BOOLEAN NOT NULL DEFAULT false,
    "prerequisitesConfirmedByDirector" BOOLEAN NOT NULL DEFAULT false,
    "requirementOverrideReason" TEXT,
    "requirementOverriddenByUserId" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "offeredAt" TIMESTAMP(3),
    "offerExpiresAt" TIMESTAMP(3),
    "offerCount" INTEGER NOT NULL DEFAULT 0,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HonorClassWaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HonorClassWaitlistEntry_offeringId_status_joinOrder_idx" ON "HonorClassWaitlistEntry"("offeringId", "status", "joinOrder");

-- CreateIndex
CREATE INDEX "HonorClassWaitlistEntry_registrationId_status_idx" ON "HonorClassWaitlistEntry"("registrationId", "status");

-- CreateIndex
CREATE INDEX "HonorClassWaitlistEntry_registrationAttendeeId_idx" ON "HonorClassWaitlistEntry"("registrationAttendeeId");

-- CreateIndex
CREATE INDEX "HonorClassWaitlistEntry_status_offerExpiresAt_idx" ON "HonorClassWaitlistEntry"("status", "offerExpiresAt");

-- CreateIndex
CREATE INDEX "HonorClassWaitlistEntry_eventId_idx" ON "HonorClassWaitlistEntry"("eventId");

-- AddForeignKey
ALTER TABLE "HonorClassWaitlistEntry" ADD CONSTRAINT "HonorClassWaitlistEntry_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HonorClassWaitlistEntry" ADD CONSTRAINT "HonorClassWaitlistEntry_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "HonorOffering"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HonorClassWaitlistEntry" ADD CONSTRAINT "HonorClassWaitlistEntry_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HonorClassWaitlistEntry" ADD CONSTRAINT "HonorClassWaitlistEntry_registrationAttendeeId_fkey" FOREIGN KEY ("registrationAttendeeId") REFERENCES "RegistrationAttendee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HonorClassWaitlistEntry" ADD CONSTRAINT "HonorClassWaitlistEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HonorClassWaitlistEntry" ADD CONSTRAINT "HonorClassWaitlistEntry_requirementOverriddenByUserId_fkey" FOREIGN KEY ("requirementOverriddenByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One open place (waiting or holding an offer) per person and class.
CREATE UNIQUE INDEX "HonorClassWaitlistEntry_one_open_per_person_class" ON "HonorClassWaitlistEntry"("registrationAttendeeId", "offeringId") WHERE "status" IN ('WAITING', 'OFFERED');

-- A held offer always has its expiry, and the acceptance window is a sensible number of hours.
ALTER TABLE "HonorClassWaitlistEntry" ADD CONSTRAINT "HonorClassWaitlistEntry_offer_has_expiry" CHECK ("status" <> 'OFFERED' OR ("offeredAt" IS NOT NULL AND "offerExpiresAt" IS NOT NULL));
ALTER TABLE "Event" ADD CONSTRAINT "Event_honorWaitlistOfferHours_range" CHECK ("honorWaitlistOfferHours" BETWEEN 1 AND 168);
