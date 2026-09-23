-- Public conference calendar (#107): per-event visibility and category, and
-- staff-entered informational entries.

-- CreateEnum
CREATE TYPE "CalendarEntryStatus" AS ENUM ('SCHEDULED', 'POSTPONED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "calendarCategory" TEXT,
ADD COLUMN     "showOnCalendar" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "CalendarEntry" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "startsOn" TEXT NOT NULL,
    "endsOn" TEXT NOT NULL,
    "timeLabel" TEXT NOT NULL DEFAULT '',
    "location" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT '',
    "linkUrl" TEXT,
    "status" "CalendarEntryStatus" NOT NULL DEFAULT 'SCHEDULED',
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT NOT NULL,
    "updatedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CalendarEntry_dates_check" CHECK (
      "startsOn" ~ '^\d{4}-\d{2}-\d{2}$' AND "endsOn" ~ '^\d{4}-\d{2}-\d{2}$' AND "endsOn" >= "startsOn"
    )
);

-- CreateIndex
CREATE INDEX "CalendarEntry_isPublished_startsOn_idx" ON "CalendarEntry"("isPublished", "startsOn");
