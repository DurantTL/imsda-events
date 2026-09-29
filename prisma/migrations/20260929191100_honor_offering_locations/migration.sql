-- All-sessions Honors classes belong to an event location (#589). Additive: one
-- nullable column, so every existing class keeps location NULL and behaves as
-- before. A single-session class takes its site from its session, so the column
-- is only for ALL_SESSIONS classes (CHECK). Hand-written; matches
-- `prisma migrate diff` (Prisma leaves the CHECK and partial indexes alone).

-- AlterTable
ALTER TABLE "HonorOffering" ADD COLUMN     "locationId" TEXT;

-- CreateIndex
CREATE INDEX "HonorOffering_locationId_idx" ON "HonorOffering"("locationId");

-- AddForeignKey
ALTER TABLE "HonorOffering" ADD CONSTRAINT "HonorOffering_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "EventLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "HonorOffering"
  ADD CONSTRAINT "HonorOffering_locationId_all_sessions" CHECK ("locationId" IS NULL OR "span" = 'ALL_SESSIONS');

-- One all-sessions class per honor per site. The event-wide index becomes two:
-- classes with no site keep today's rule (one per honor per event); classes at
-- a site are one per honor per site, so two sites can both run the same honor
-- across all sessions. Existing rows all have a NULL site, so the first index
-- accepts exactly the rows the old one did.
DROP INDEX "HonorOffering_eventId_honorId_all_sessions_key";

CREATE UNIQUE INDEX "HonorOffering_eventId_honorId_all_sessions_no_location_key"
  ON "HonorOffering"("eventId", "honorId") WHERE "sessionId" IS NULL AND "locationId" IS NULL;

CREATE UNIQUE INDEX "HonorOffering_eventId_honorId_locationId_all_sessions_key"
  ON "HonorOffering"("eventId", "honorId", "locationId") WHERE "sessionId" IS NULL AND "locationId" IS NOT NULL;
