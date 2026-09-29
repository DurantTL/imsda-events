-- Location waitlists and an Area Coordinator per location (#599). Additive
-- only: one nullable column, one new table with its enum, and one new
-- message-template enum value, so existing events, locations and registrations
-- behave exactly as before. Hand-written; matches `prisma migrate diff`
-- against the schema exactly.

-- A new enum value cannot be used in the transaction that adds it, so this
-- closes the implicit transaction the way ACCOUNT_LOCKOUT and
-- SHIRT_SIZE_REQUEST did before it.
ALTER TYPE "MessageTemplateKey" ADD VALUE IF NOT EXISTS 'LOCATION_WAITLIST_DIGEST';

COMMIT;

-- CreateEnum
CREATE TYPE "LocationWaitlistChangeKind" AS ENUM ('JOINED', 'PROMOTED', 'REMOVED');

-- AlterTable
ALTER TABLE "EventLocation" ADD COLUMN     "coordinatorAccountId" TEXT;

-- CreateTable
CREATE TABLE "LocationWaitlistChange" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "kind" "LocationWaitlistChangeKind" NOT NULL,
    "clubName" TEXT NOT NULL,
    "locationName" TEXT NOT NULL,
    "attendeeCount" INTEGER NOT NULL,
    "place" INTEGER,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "digestedAt" TIMESTAMP(3),

    CONSTRAINT "LocationWaitlistChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LocationWaitlistChange_digestedAt_occurredAt_idx" ON "LocationWaitlistChange"("digestedAt", "occurredAt");

-- CreateIndex
CREATE INDEX "LocationWaitlistChange_locationId_occurredAt_idx" ON "LocationWaitlistChange"("locationId", "occurredAt");

-- CreateIndex
CREATE INDEX "LocationWaitlistChange_registrationId_idx" ON "LocationWaitlistChange"("registrationId");

-- CreateIndex
CREATE INDEX "EventLocation_coordinatorAccountId_idx" ON "EventLocation"("coordinatorAccountId");

-- AddForeignKey
ALTER TABLE "EventLocation" ADD CONSTRAINT "EventLocation_coordinatorAccountId_fkey" FOREIGN KEY ("coordinatorAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationWaitlistChange" ADD CONSTRAINT "LocationWaitlistChange_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationWaitlistChange" ADD CONSTRAINT "LocationWaitlistChange_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "EventLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationWaitlistChange" ADD CONSTRAINT "LocationWaitlistChange_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
