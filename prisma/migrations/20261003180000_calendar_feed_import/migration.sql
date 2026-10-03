-- Google Calendar (ICS) import (#444 part B). Additive only: existing entries
-- keep null source fields and behave exactly as before.
CREATE TYPE "CalendarFeedStatus" AS ENUM ('OK', 'FAILED');

CREATE TABLE "CalendarFeed" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sealedUrl" TEXT NOT NULL,
  "urlHint" TEXT NOT NULL,
  "defaultCategory" TEXT NOT NULL DEFAULT '',
  "defaultEntryType" "CalendarEntryType" NOT NULL DEFAULT 'STANDARD',
  "publishNewItems" BOOLEAN NOT NULL DEFAULT false,
  "isEnabled" BOOLEAN NOT NULL DEFAULT true,
  "refreshMinutes" INTEGER NOT NULL DEFAULT 60,
  "lastFetchedAt" TIMESTAMP(3),
  "lastSucceededAt" TIMESTAMP(3),
  "lastStatus" "CalendarFeedStatus",
  "lastError" TEXT,
  "lastItemCount" INTEGER,
  "createdByUserId" TEXT NOT NULL,
  "updatedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CalendarFeed_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CalendarEntry"
  ADD COLUMN "sourceFeedId" TEXT,
  ADD COLUMN "sourceUid" TEXT,
  ADD COLUMN "sourceRecurrenceId" TEXT,
  ADD COLUMN "sourceHash" TEXT,
  ADD COLUMN "sourceRemovedAt" TIMESTAMP(3),
  ADD COLUMN "sourceRemovedWasPublished" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "locallyEditedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "isHiddenLocally" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "CalendarEntry_sourceFeedId_sourceUid_sourceRecurrenceId_key"
  ON "CalendarEntry"("sourceFeedId", "sourceUid", "sourceRecurrenceId");

ALTER TABLE "CalendarEntry"
  ADD CONSTRAINT "CalendarEntry_sourceFeedId_fkey"
  FOREIGN KEY ("sourceFeedId") REFERENCES "CalendarFeed"("id") ON DELETE SET NULL ON UPDATE CASCADE;
