-- #724: who set a church location, and the staff-reviewed geocoding results.
CREATE TYPE "ChurchLocationSource" AS ENUM ('IMPORT', 'MANUAL', 'GEOCODED');
CREATE TYPE "ChurchGeocodeStatus" AS ENUM ('MATCHED', 'NO_MATCH');
CREATE TYPE "ChurchGeocodeDecision" AS ENUM ('PENDING', 'ACCEPTED', 'SKIPPED');

-- Every existing row was set by hand (nothing was imported or geocoded
-- before), so the default backfills them as MANUAL and the import and the
-- geocoder will never overwrite them.
ALTER TABLE "ChurchLocation" ADD COLUMN "source" "ChurchLocationSource" NOT NULL DEFAULT 'MANUAL';

CREATE TABLE "ChurchGeocodeResult" (
    "organizationId" TEXT NOT NULL,
    "status" "ChurchGeocodeStatus" NOT NULL,
    "decision" "ChurchGeocodeDecision" NOT NULL DEFAULT 'PENDING',
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "matchedAddress" TEXT NOT NULL DEFAULT '',
    "provider" TEXT NOT NULL,
    -- The address that was sent: a match is refused once the church's address no longer matches it.
    "inputStreet" TEXT NOT NULL DEFAULT '',
    "inputCity" TEXT NOT NULL DEFAULT '',
    "inputState" TEXT NOT NULL DEFAULT '',
    "inputZip" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChurchGeocodeResult_pkey" PRIMARY KEY ("organizationId")
);

ALTER TABLE "ChurchGeocodeResult" ADD CONSTRAINT "ChurchGeocodeResult_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
