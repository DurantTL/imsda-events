ALTER TABLE "Announcement"
  ADD COLUMN "pinnedAt" TIMESTAMP(3),
  ADD COLUMN "pinnedByUserId" TEXT;

ALTER TABLE "Announcement"
  ADD CONSTRAINT "Announcement_pinnedByUserId_fkey"
  FOREIGN KEY ("pinnedByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Announcement_eventId_status_pinnedAt_publishedAt_idx"
  ON "Announcement"("eventId", "status", "pinnedAt", "publishedAt");
