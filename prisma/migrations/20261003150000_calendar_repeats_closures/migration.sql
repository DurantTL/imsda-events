-- Repeating calendar entries and office closures (#444). Additive only:
-- existing entries become STANDARD, non-repeating items.
CREATE TYPE "CalendarEntryType" AS ENUM ('STANDARD', 'CLOSURE');

ALTER TABLE "CalendarEntry"
  ADD COLUMN "entryType" "CalendarEntryType" NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN "repeatRule" TEXT,
  ADD COLUMN "repeatExceptions" TEXT[] DEFAULT ARRAY[]::TEXT[];
