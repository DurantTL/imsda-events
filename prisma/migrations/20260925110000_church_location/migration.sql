-- Q1 (#437): a church's town and, when staff hand-enter them, map
-- coordinates. Used only to plot listed clubs on the public club map.

-- CreateTable
CREATE TABLE "ChurchLocation" (
    "organizationId" TEXT NOT NULL,
    "city" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT '',
    "zip" TEXT NOT NULL DEFAULT '',
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChurchLocation_pkey" PRIMARY KEY ("organizationId")
);

-- AddForeignKey
ALTER TABLE "ChurchLocation" ADD CONSTRAINT "ChurchLocation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
