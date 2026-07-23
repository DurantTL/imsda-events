-- CreateEnum
CREATE TYPE "WaitlistEntryStatus" AS ENUM ('WAITING', 'PROMOTED', 'REMOVED');

-- AlterTable
ALTER TABLE "Event"
ADD COLUMN "registrationOpensOn" TEXT,
ADD COLUMN "registrationClosesOn" TEXT,
ADD COLUMN "waitlistEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "autoPromoteWaitlist" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Registration"
ADD COLUMN "contactSnapshot" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "cancelledAt" TIMESTAMP(3);

-- Preserve the submitted contact shown to staff for existing records.
UPDATE "Registration" AS registration
SET "contactSnapshot" = jsonb_build_object(
  'firstName', person."firstName",
  'lastName', person."lastName",
  'email', person."normalizedEmail",
  'phone', person."phone"
)
FROM "Person" AS person
WHERE person."id" = registration."accountHolderPersonId";

-- CreateTable
CREATE TABLE "RegistrationWaitlistEntry" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "registrationId" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "attendeeCount" INTEGER NOT NULL,
  "status" "WaitlistEntryStatus" NOT NULL DEFAULT 'WAITING',
  "lastBlockedReason" TEXT,
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "promotedAt" TIMESTAMP(3),
  "removedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "RegistrationWaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- Preserve pre-existing waitlisted registrations in a deterministic event queue.
INSERT INTO "RegistrationWaitlistEntry" (
  "id",
  "eventId",
  "registrationId",
  "position",
  "attendeeCount",
  "status",
  "joinedAt",
  "createdAt",
  "updatedAt"
)
SELECT
  'waitlist_migrated_' || registration."id",
  registration."eventId",
  registration."id",
  ROW_NUMBER() OVER (
    PARTITION BY registration."eventId"
    ORDER BY registration."createdAt", registration."id"
  ),
  COUNT(attendee."id")::INTEGER,
  'WAITING'::"WaitlistEntryStatus",
  COALESCE(registration."submittedAt", registration."createdAt"),
  registration."createdAt",
  CURRENT_TIMESTAMP
FROM "Registration" AS registration
LEFT JOIN "RegistrationAttendee" AS attendee
  ON attendee."registrationId" = registration."id"
WHERE registration."status" = 'WAITLISTED'
GROUP BY registration."id";

-- Cancelled and waitlisted records must not retain live option inventory.
UPDATE "RegistrationCapacityReservation" AS reservation
SET "releasedAt" = CURRENT_TIMESTAMP
FROM "Registration" AS registration
WHERE registration."id" = reservation."registrationId"
  AND registration."status" IN ('CANCELLED', 'WAITLISTED')
  AND reservation."releasedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationWaitlistEntry_registrationId_key"
ON "RegistrationWaitlistEntry"("registrationId");

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationWaitlistEntry_eventId_position_key"
ON "RegistrationWaitlistEntry"("eventId", "position");

-- CreateIndex
CREATE INDEX "RegistrationWaitlistEntry_eventId_status_position_idx"
ON "RegistrationWaitlistEntry"("eventId", "status", "position");

-- AddForeignKey
ALTER TABLE "RegistrationWaitlistEntry"
ADD CONSTRAINT "RegistrationWaitlistEntry_eventId_fkey"
FOREIGN KEY ("eventId") REFERENCES "Event"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationWaitlistEntry"
ADD CONSTRAINT "RegistrationWaitlistEntry_registrationId_fkey"
FOREIGN KEY ("registrationId") REFERENCES "Registration"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
