-- CreateEnum
CREATE TYPE "LodgingUnitKind" AS ENUM ('ROOM', 'RV_SITE', 'TENT');

-- CreateEnum
CREATE TYPE "LodgingBedType" AS ENUM ('QUEEN', 'DOUBLE', 'TWIN', 'TWIN_BUNK');

-- CreateEnum
CREATE TYPE "LodgingBathroom" AS ENUM ('PRIVATE', 'SHARED', 'BATHHOUSE', 'UNSPECIFIED');

-- CreateEnum
CREATE TYPE "LodgingCategory" AS ENUM ('DORM_ROOM', 'CONFERENCE_CENTER_ROOM', 'RV_SITE', 'TENT_WITH_POWER', 'TENT');

-- CreateEnum
CREATE TYPE "LodgingRateBasis" AS ENUM ('PER_UNIT_NIGHT', 'PER_PERSON_NIGHT');

-- CreateEnum
CREATE TYPE "LodgingHoldKind" AS ENUM ('STAFF', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "LodgingHoldHistoryType" AS ENUM ('CREATED', 'WINDOW_CHANGED', 'RELEASED');

-- CreateTable
CREATE TABLE "LodgingProperty" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LodgingProperty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LodgingBuilding" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LodgingBuilding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LodgingUnit" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "LodgingUnitKind" NOT NULL,
    "isArea" BOOLEAN NOT NULL DEFAULT false,
    "category" "LodgingCategory",
    "floor" INTEGER,
    "groundLevel" BOOLEAN NOT NULL DEFAULT false,
    "bathroom" "LodgingBathroom" NOT NULL DEFAULT 'UNSPECIFIED',
    "linensProvided" BOOLEAN,
    "specialUse" BOOLEAN NOT NULL DEFAULT false,
    "assignable" BOOLEAN NOT NULL DEFAULT true,
    "defaultCapacity" INTEGER,
    "defaultUnavailable" BOOLEAN NOT NULL DEFAULT false,
    "defaultHoldKind" "LodgingHoldKind",
    "defaultHoldReason" TEXT,
    "notes" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "activeFrom" DATE,
    "activeUntil" DATE,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LodgingUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LodgingBed" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "type" "LodgingBedType" NOT NULL,
    "sleeps" INTEGER NOT NULL,

    CONSTRAINT "LodgingBed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventLodging" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "firstNight" DATE,
    "lastNight" DATE,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventLodging_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventLodgingUnit" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventLodgingId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "defaultCapacity" INTEGER,
    "bedsSummary" TEXT NOT NULL DEFAULT '',
    "assignable" BOOLEAN NOT NULL DEFAULT true,
    "retired" BOOLEAN NOT NULL DEFAULT false,
    "capacityOverride" INTEGER,
    "unavailable" BOOLEAN NOT NULL DEFAULT false,
    "unavailableReason" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventLodgingUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventLodgingHold" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventLodgingUnitId" TEXT NOT NULL,
    "kind" "LodgingHoldKind" NOT NULL,
    "reason" TEXT NOT NULL,
    "firstNight" DATE NOT NULL,
    "lastNight" DATE NOT NULL,
    "systemDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "releasedByUserId" TEXT,
    "releaseReason" TEXT,

    CONSTRAINT "EventLodgingHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventLodgingHoldHistory" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "holdId" TEXT NOT NULL,
    "type" "LodgingHoldHistoryType" NOT NULL,
    "actorUserId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" "LodgingHoldKind",
    "reason" TEXT,
    "firstNight" DATE,
    "lastNight" DATE,

    CONSTRAINT "EventLodgingHoldHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventLodgingRate" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventLodgingId" TEXT NOT NULL,
    "category" "LodgingCategory" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "basis" "LodgingRateBasis" NOT NULL,
    "minimumNights" INTEGER,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventLodgingRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LodgingProperty_key_key" ON "LodgingProperty"("key");

-- CreateIndex
CREATE UNIQUE INDEX "LodgingBuilding_propertyId_key_key" ON "LodgingBuilding"("propertyId", "key");

-- CreateIndex
CREATE INDEX "LodgingUnit_buildingId_sortOrder_idx" ON "LodgingUnit"("buildingId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "LodgingUnit_propertyId_key_key" ON "LodgingUnit"("propertyId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "LodgingBed_unitId_position_key" ON "LodgingBed"("unitId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "EventLodging_eventId_key" ON "EventLodging"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "EventLodging_id_eventId_key" ON "EventLodging"("id", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "EventLodgingUnit_eventLodgingId_unitId_key" ON "EventLodgingUnit"("eventLodgingId", "unitId");

-- CreateIndex
CREATE UNIQUE INDEX "EventLodgingUnit_id_eventId_key" ON "EventLodgingUnit"("id", "eventId");

-- CreateIndex
CREATE INDEX "EventLodgingHold_eventLodgingUnitId_releasedAt_idx" ON "EventLodgingHold"("eventLodgingUnitId", "releasedAt");

-- CreateIndex
CREATE INDEX "EventLodgingHold_eventId_idx" ON "EventLodgingHold"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "EventLodgingHold_id_eventId_key" ON "EventLodgingHold"("id", "eventId");

-- CreateIndex
CREATE INDEX "EventLodgingHoldHistory_holdId_at_idx" ON "EventLodgingHoldHistory"("holdId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "EventLodgingRate_eventLodgingId_category_key" ON "EventLodgingRate"("eventLodgingId", "category");

-- AddForeignKey
ALTER TABLE "LodgingBuilding" ADD CONSTRAINT "LodgingBuilding_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "LodgingProperty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LodgingUnit" ADD CONSTRAINT "LodgingUnit_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "LodgingProperty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LodgingUnit" ADD CONSTRAINT "LodgingUnit_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "LodgingBuilding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LodgingBed" ADD CONSTRAINT "LodgingBed_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "LodgingUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodging" ADD CONSTRAINT "EventLodging_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodging" ADD CONSTRAINT "EventLodging_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "LodgingProperty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingUnit" ADD CONSTRAINT "EventLodgingUnit_eventLodgingId_eventId_fkey" FOREIGN KEY ("eventLodgingId", "eventId") REFERENCES "EventLodging"("id", "eventId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingUnit" ADD CONSTRAINT "EventLodgingUnit_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "LodgingUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingHold" ADD CONSTRAINT "EventLodgingHold_eventLodgingUnitId_eventId_fkey" FOREIGN KEY ("eventLodgingUnitId", "eventId") REFERENCES "EventLodgingUnit"("id", "eventId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingHoldHistory" ADD CONSTRAINT "EventLodgingHoldHistory_holdId_eventId_fkey" FOREIGN KEY ("holdId", "eventId") REFERENCES "EventLodgingHold"("id", "eventId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingRate" ADD CONSTRAINT "EventLodgingRate_eventLodgingId_eventId_fkey" FOREIGN KEY ("eventLodgingId", "eventId") REFERENCES "EventLodging"("id", "eventId") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Constraints Prisma cannot express (#198). Additive only.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "LodgingUnit" ADD CONSTRAINT "LodgingUnit_capacity_nonnegative" CHECK ("defaultCapacity" IS NULL OR "defaultCapacity" >= 0);
ALTER TABLE "LodgingUnit" ADD CONSTRAINT "LodgingUnit_effective_dates" CHECK ("activeFrom" IS NULL OR "activeUntil" IS NULL OR "activeUntil" >= "activeFrom");
ALTER TABLE "LodgingBed" ADD CONSTRAINT "LodgingBed_sleeps_positive" CHECK ("sleeps" > 0);
ALTER TABLE "EventLodging" ADD CONSTRAINT "EventLodging_night_window" CHECK ("firstNight" IS NULL OR "lastNight" IS NULL OR "lastNight" >= "firstNight");
ALTER TABLE "EventLodgingUnit" ADD CONSTRAINT "EventLodgingUnit_capacity_nonnegative" CHECK ("capacityOverride" IS NULL OR "capacityOverride" >= 0);
ALTER TABLE "EventLodgingHold" ADD CONSTRAINT "EventLodgingHold_window" CHECK ("lastNight" >= "firstNight");
ALTER TABLE "EventLodgingHold" ADD CONSTRAINT "EventLodgingHold_reason_present" CHECK (length(btrim("reason")) > 0);
ALTER TABLE "EventLodgingHold" ADD CONSTRAINT "EventLodgingHold_release_fields" CHECK (("releasedAt" IS NULL) = ("releaseReason" IS NULL));
ALTER TABLE "EventLodgingRate" ADD CONSTRAINT "EventLodgingRate_amount_nonnegative" CHECK ("amountCents" >= 0);
ALTER TABLE "EventLodgingRate" ADD CONSTRAINT "EventLodgingRate_minimum_nights_positive" CHECK ("minimumNights" IS NULL OR "minimumNights" >= 1);

-- A unit has at most one active (unreleased) hold on any night: overlapping windows are refused by the
-- database, so two racing requests cannot both hold (or, in #200, both allocate) one exclusive unit.
ALTER TABLE "EventLodgingHold" ADD CONSTRAINT "EventLodgingHold_no_overlap"
  EXCLUDE USING gist ("eventLodgingUnitId" WITH =, daterange("firstNight", "lastNight", '[]') WITH &&)
  WHERE ("releasedAt" IS NULL);

-- A property's structure must stay consistent: an event's unit rows come from the property the event
-- chose, a unit sits in a building of its own property, and nothing an event references can move.
CREATE FUNCTION "EventLodgingUnit_same_property"() RETURNS trigger AS $$
BEGIN
  IF (SELECT "propertyId" FROM "EventLodging" WHERE "id" = NEW."eventLodgingId")
     IS DISTINCT FROM (SELECT "propertyId" FROM "LodgingUnit" WHERE "id" = NEW."unitId") THEN
    RAISE EXCEPTION 'The unit belongs to a different lodging property than the event.' USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EventLodgingUnit_same_property" BEFORE INSERT OR UPDATE OF "unitId", "eventLodgingId" ON "EventLodgingUnit" FOR EACH ROW EXECUTE FUNCTION "EventLodgingUnit_same_property"();

CREATE FUNCTION "EventLodging_property_fixed"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "EventLodgingUnit" eu JOIN "LodgingUnit" u ON u."id" = eu."unitId"
    WHERE eu."eventLodgingId" = NEW."id" AND u."propertyId" <> NEW."propertyId"
  ) THEN
    RAISE EXCEPTION 'An event with lodging units cannot move to a different property.' USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EventLodging_property_fixed" BEFORE UPDATE OF "propertyId" ON "EventLodging" FOR EACH ROW EXECUTE FUNCTION "EventLodging_property_fixed"();

CREATE FUNCTION "LodgingUnit_structure"() RETURNS trigger AS $$
BEGIN
  IF (SELECT "propertyId" FROM "LodgingBuilding" WHERE "id" = NEW."buildingId") IS DISTINCT FROM NEW."propertyId" THEN
    RAISE EXCEPTION 'The unit''s building belongs to a different lodging property.' USING ERRCODE = '23001';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."propertyId" <> OLD."propertyId" AND EXISTS (SELECT 1 FROM "EventLodgingUnit" WHERE "unitId" = NEW."id") THEN
    RAISE EXCEPTION 'A unit that events use cannot move to a different property.' USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "LodgingUnit_structure" BEFORE INSERT OR UPDATE OF "propertyId", "buildingId" ON "LodgingUnit" FOR EACH ROW EXECUTE FUNCTION "LodgingUnit_structure"();

CREATE FUNCTION "LodgingBuilding_property_fixed"() RETURNS trigger AS $$
BEGIN
  IF NEW."propertyId" <> OLD."propertyId" AND EXISTS (SELECT 1 FROM "LodgingUnit" WHERE "buildingId" = NEW."id") THEN
    RAISE EXCEPTION 'A building with units cannot move to a different property.' USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "LodgingBuilding_property_fixed" BEFORE UPDATE OF "propertyId" ON "LodgingBuilding" FOR EACH ROW EXECUTE FUNCTION "LodgingBuilding_property_fixed"();

-- Event lodging rows are never deleted on their own. The only exception is the rows going with their
-- event, from inside a foreign-key action (pg_trigger_depth() > 1) once the Event itself is gone.
CREATE FUNCTION "EventLodging_refuse_delete"() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 AND NOT EXISTS (SELECT 1 FROM "Event" WHERE "id" = OLD."eventId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Event lodging rows are never deleted while the event exists.' USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EventLodging_no_delete" BEFORE DELETE ON "EventLodging" FOR EACH ROW EXECUTE FUNCTION "EventLodging_refuse_delete"();
CREATE TRIGGER "EventLodgingUnit_no_delete" BEFORE DELETE ON "EventLodgingUnit" FOR EACH ROW EXECUTE FUNCTION "EventLodging_refuse_delete"();
CREATE TRIGGER "EventLodgingHoldHistory_no_delete" BEFORE DELETE ON "EventLodgingHoldHistory" FOR EACH ROW EXECUTE FUNCTION "EventLodging_refuse_delete"();

-- A hold is never deleted, and only its window and release fields ever change. A released hold never
-- changes again, so it is released once.
CREATE FUNCTION "EventLodgingHold_guard"() RETURNS trigger AS $$
DECLARE
  changeable CONSTANT text[] := ARRAY['firstNight', 'lastNight', 'releasedAt', 'releasedByUserId', 'releaseReason'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 AND NOT EXISTS (SELECT 1 FROM "Event" WHERE "id" = OLD."eventId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'A lodging hold is never deleted; release it.' USING ERRCODE = '23001';
  END IF;
  IF OLD."releasedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'A released lodging hold is never changed.' USING ERRCODE = '23001';
  END IF;
  IF (to_jsonb(NEW) - changeable) <> (to_jsonb(OLD) - changeable) THEN
    RAISE EXCEPTION 'A lodging hold changes only its window and its release.' USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EventLodgingHold_guard" BEFORE UPDATE OR DELETE ON "EventLodgingHold" FOR EACH ROW EXECUTE FUNCTION "EventLodgingHold_guard"();

-- Hold history is append-only: never rewritten (deletes are refused by EventLodgingHoldHistory_no_delete).
CREATE FUNCTION "EventLodgingHoldHistory_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Lodging hold history is append-only.' USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EventLodgingHoldHistory_append_only" BEFORE UPDATE ON "EventLodgingHoldHistory" FOR EACH ROW EXECUTE FUNCTION "EventLodgingHoldHistory_append_only"();
