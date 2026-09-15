-- Artwork printed behind every attendee name badge for an event.
--
-- RESTRICT rather than SET NULL: deleting the file an event prints badges
-- from should fail loudly at the delete, not quietly produce plain badges on
-- the morning of check-in.
ALTER TABLE "Event" ADD COLUMN "badgeBackgroundAssetId" TEXT;

ALTER TABLE "Event"
  ADD CONSTRAINT "Event_badgeBackgroundAssetId_fkey"
  FOREIGN KEY ("badgeBackgroundAssetId") REFERENCES "EventAsset"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "Event_badgeBackgroundAssetId_idx" ON "Event"("badgeBackgroundAssetId");
