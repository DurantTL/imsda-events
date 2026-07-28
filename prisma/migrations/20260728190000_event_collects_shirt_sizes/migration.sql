-- Shirt collection becomes a stored capability instead of a match on the
-- event's name.
ALTER TABLE "Event" ADD COLUMN "collectsShirtSizes" BOOLEAN NOT NULL DEFAULT false;

-- Backfill from the predicate being retired, so the events that collect sizes
-- today keep collecting them. Written to match the old rule exactly: the slug
-- contained "womens-retreat", or the name matched women's retreat with any
-- apostrophe or none. Anything looser would switch collection on for an event
-- that never had it.
UPDATE "Event"
SET "collectsShirtSizes" = true
WHERE "slug" LIKE '%womens-retreat%'
   OR "name" ~* '\mwomen(''|’)?s?[[:space:]]+retreat\M';
