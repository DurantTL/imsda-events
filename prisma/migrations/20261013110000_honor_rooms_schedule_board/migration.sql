-- Honors Weekend schedule board (#834). Additive only: a table of rooms inside
-- a site (with a capacity), and a nullable room on the class. Nothing existing
-- is rewritten; a class with no room behaves exactly as before.

-- CreateTable
CREATE TABLE "HonorRoom" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "locationId" TEXT,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HonorRoom_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "HonorRoom_capacity_check" CHECK ("capacity" >= 1)
);

-- AlterTable
ALTER TABLE "HonorOffering" ADD COLUMN "roomId" TEXT;

-- CreateIndex
CREATE INDEX "HonorRoom_eventId_locationId_sortOrder_idx" ON "HonorRoom"("eventId", "locationId", "sortOrder");
CREATE INDEX "HonorRoom_locationId_idx" ON "HonorRoom"("locationId");
CREATE INDEX "HonorOffering_roomId_idx" ON "HonorOffering"("roomId");

-- Room names are unique within a site, or within an event that has no sites
-- (Prisma can't model partial indexes; `migrate diff` leaves them alone).
CREATE UNIQUE INDEX "HonorRoom_eventId_normalizedName_noSite_key" ON "HonorRoom"("eventId", "normalizedName") WHERE "locationId" IS NULL;
CREATE UNIQUE INDEX "HonorRoom_eventId_locationId_normalizedName_key" ON "HonorRoom"("eventId", "locationId", "normalizedName") WHERE "locationId" IS NOT NULL;

-- One active class per room per session. (An all-sessions class holds the room
-- for every session; the repository checks that against single-session classes.)
CREATE UNIQUE INDEX "HonorOffering_roomId_sessionId_active_key" ON "HonorOffering"("roomId", "sessionId") WHERE "roomId" IS NOT NULL AND "sessionId" IS NOT NULL AND "isActive";

-- AddForeignKey
ALTER TABLE "HonorRoom" ADD CONSTRAINT "HonorRoom_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HonorRoom" ADD CONSTRAINT "HonorRoom_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "EventLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HonorOffering" ADD CONSTRAINT "HonorOffering_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "HonorRoom"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A class never has more seats than its room. Backstops the repository checks:
-- one trigger on the class (placing it in a room, or raising its seats), one on
-- the room (lowering its capacity below a class placed in it).
CREATE FUNCTION "honor_offering_within_room_capacity"() RETURNS trigger AS $$
DECLARE
  room_capacity INTEGER;
BEGIN
  IF NEW."roomId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "capacity" INTO room_capacity FROM "HonorRoom" WHERE "id" = NEW."roomId";
  IF room_capacity IS NOT NULL AND NEW."capacity" > room_capacity THEN
    RAISE EXCEPTION 'HonorOffering capacity % exceeds its room capacity %', NEW."capacity", room_capacity
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "HonorOffering_within_room_capacity"
BEFORE INSERT OR UPDATE OF "capacity", "roomId" ON "HonorOffering"
FOR EACH ROW EXECUTE FUNCTION "honor_offering_within_room_capacity"();

CREATE FUNCTION "honor_room_covers_its_classes"() RETURNS trigger AS $$
BEGIN
  IF NEW."capacity" < OLD."capacity" AND EXISTS (
    SELECT 1 FROM "HonorOffering" WHERE "roomId" = NEW."id" AND "capacity" > NEW."capacity"
  ) THEN
    RAISE EXCEPTION 'HonorRoom capacity % is below a class placed in it', NEW."capacity"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "HonorRoom_covers_its_classes"
BEFORE UPDATE OF "capacity" ON "HonorRoom"
FOR EACH ROW EXECUTE FUNCTION "honor_room_covers_its_classes"();
