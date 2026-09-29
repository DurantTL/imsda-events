-- Multiple locations inside one event (#413). Additive only: a new table and a
-- nullable column, so existing events and registrations behave exactly as
-- before. Restrict on delete: a location that registrations use cannot be
-- deleted (staff deactivate it instead). Hand-written; matches
-- `prisma migrate diff` against the schema exactly.

-- AlterTable
ALTER TABLE "Registration" ADD COLUMN     "locationId" TEXT;

-- CreateTable
CREATE TABLE "EventLocation" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "address" TEXT,
    "firstDay" TEXT,
    "lastDay" TEXT,
    "capacity" INTEGER,
    "registrationClosesOn" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventLocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventLocation_eventId_isActive_sortOrder_idx" ON "EventLocation"("eventId", "isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "EventLocation_eventId_normalizedName_key" ON "EventLocation"("eventId", "normalizedName");

-- CreateIndex
CREATE INDEX "Registration_locationId_idx" ON "Registration"("locationId");

-- AddForeignKey
ALTER TABLE "EventLocation" ADD CONSTRAINT "EventLocation_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Registration" ADD CONSTRAINT "Registration_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "EventLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
