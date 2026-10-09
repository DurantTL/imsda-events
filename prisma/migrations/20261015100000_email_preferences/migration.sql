-- #838: unsubscribe and email preferences for event announcements.
--
-- Additive only. A new opt-out table keyed on the normalised email address (the preference follows the address, not a
-- registration), and an "essential" flag on announcements that lets an event manager reach people who opted out.
-- Existing announcements are not essential and nobody is opted out, so no existing behaviour changes.

-- CreateEnum
CREATE TYPE "EmailAnnouncementOptOutScope" AS ENUM ('EVENT', 'ALL');

-- AlterTable
ALTER TABLE "Announcement" ADD COLUMN "isEssential" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "EmailAnnouncementOptOut" (
    "id" TEXT NOT NULL,
    "normalizedEmail" TEXT NOT NULL,
    "scope" "EmailAnnouncementOptOutScope" NOT NULL,
    "eventId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailAnnouncementOptOut_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailAnnouncementOptOut_normalizedEmail_scopeKey_key" ON "EmailAnnouncementOptOut"("normalizedEmail", "scopeKey");

-- CreateIndex
CREATE INDEX "EmailAnnouncementOptOut_eventId_createdAt_idx" ON "EmailAnnouncementOptOut"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailAnnouncementOptOut_normalizedEmail_idx" ON "EmailAnnouncementOptOut"("normalizedEmail");

-- AddForeignKey
ALTER TABLE "EmailAnnouncementOptOut" ADD CONSTRAINT "EmailAnnouncementOptOut_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "EmailUnsubscribeToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "normalizedEmail" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailUnsubscribeToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailUnsubscribeToken_tokenHash_key" ON "EmailUnsubscribeToken"("tokenHash");

-- CreateIndex
CREATE INDEX "EmailUnsubscribeToken_eventId_idx" ON "EmailUnsubscribeToken"("eventId");

-- AddForeignKey
ALTER TABLE "EmailUnsubscribeToken" ADD CONSTRAINT "EmailUnsubscribeToken_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
