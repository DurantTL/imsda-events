-- Honors Weekend sessions belong to an event location (#589). Additive: one
-- nullable column, so every existing session keeps location NULL and behaves
-- exactly as before. Hand-written; matches `prisma migrate diff` against the
-- schema (the partial indexes below are not modelled by Prisma, which leaves
-- them alone, like HonorOffering_eventId_honorId_all_sessions_key).

-- AlterTable
ALTER TABLE "HonorSession" ADD COLUMN     "locationId" TEXT;

-- CreateIndex
CREATE INDEX "HonorSession_locationId_idx" ON "HonorSession"("locationId");

-- AddForeignKey
ALTER TABLE "HonorSession" ADD CONSTRAINT "HonorSession_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "EventLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Name uniqueness moves from (eventId, normalizedName) to per location, so two
-- sites can both have a "Sabbath Morning". A plain (eventId, locationId,
-- normalizedName) unique index would not do: NULLs are distinct in Postgres, so
-- sessions with no location could then repeat a name. Two partial unique
-- indexes keep today's rule exactly for sessions with no location and add the
-- per-location rule for the rest. (NULLS NOT DISTINCT would also work but needs
-- PostgreSQL 15.) Every existing row has a NULL location, so the first index
-- accepts exactly the rows the old one did.
DROP INDEX "HonorSession_eventId_normalizedName_key";

CREATE UNIQUE INDEX "HonorSession_eventId_normalizedName_no_location_key"
  ON "HonorSession"("eventId", "normalizedName") WHERE "locationId" IS NULL;

CREATE UNIQUE INDEX "HonorSession_eventId_locationId_normalizedName_key"
  ON "HonorSession"("eventId", "locationId", "normalizedName") WHERE "locationId" IS NOT NULL;
