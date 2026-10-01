-- #724: remember which address a geocode result was found for, so a match is
-- never accepted after the church's address changed. Rows that predate this
-- column hold '' and therefore never match: staff run Find map locations again.
ALTER TABLE "ChurchGeocodeResult"
    ADD COLUMN "inputStreet" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "inputCity" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "inputState" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "inputZip" TEXT NOT NULL DEFAULT '';
