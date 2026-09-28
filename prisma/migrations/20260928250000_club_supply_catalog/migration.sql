-- Club supply catalog (#531): AdventSource items with catalog numbers, honor
-- catalog numbers and categories, and each club's stock on hand.
-- Hand-written. Creates empty tables only; the catalog is filled by a staff
-- CSV import, never seeded.

-- CreateEnum
CREATE TYPE "HonorCategory" AS ENUM ('NATURE', 'HEALTH_AND_SCIENCE', 'SPIRITUAL_GROWTH_OUTREACH_AND_HERITAGE', 'ARTS_CRAFTS_AND_HOBBIES', 'RECREATION', 'HOUSEHOLD_ARTS', 'VOCATIONAL', 'OUTDOOR_INDUSTRIES', 'MISCELLANEOUS_HONORS', 'MASTER_AWARDS');

-- CreateEnum
CREATE TYPE "ClubSupplySection" AS ENUM ('INVESTITURE', 'CAMPOREES', 'PATHFINDER_BIBLE_EXPERIENCE', 'TEEN_LEADERSHIP_TRAINING', 'MISCELLANEOUS', 'CLASS_A_DRESS_APPAREL', 'CLASS_A_UNIFORM_ACCESSORIES', 'OTHER_APPAREL', 'NATURE', 'HEALTH_AND_SCIENCE', 'SPIRITUAL_GROWTH_OUTREACH_AND_HERITAGE', 'ARTS_CRAFTS_AND_HOBBIES', 'RECREATION', 'HOUSEHOLD_ARTS', 'VOCATIONAL', 'OUTDOOR_INDUSTRIES', 'MISCELLANEOUS_HONORS', 'MASTER_AWARDS');

-- AlterTable
ALTER TABLE "Honor" ADD COLUMN "catalogNumber" TEXT,
ADD COLUMN "category" "HonorCategory";

-- CreateTable
CREATE TABLE "ClubSupplyItem" (
    "id" TEXT NOT NULL,
    "section" "ClubSupplySection" NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "catalogNumber" TEXT,
    "sizeLabel" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "honorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubSupplyItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubSupplyStock" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantityOnHand" INTEGER NOT NULL DEFAULT 0,
    "updatedByAccountId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubSupplyStock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Honor_category_idx" ON "Honor"("category");

-- CreateIndex
CREATE UNIQUE INDEX "ClubSupplyItem_section_normalizedName_key" ON "ClubSupplyItem"("section", "normalizedName");

-- CreateIndex
CREATE INDEX "ClubSupplyItem_catalogNumber_idx" ON "ClubSupplyItem"("catalogNumber");

-- CreateIndex
CREATE INDEX "ClubSupplyItem_honorId_idx" ON "ClubSupplyItem"("honorId");

-- CreateIndex
CREATE INDEX "ClubSupplyItem_isActive_section_name_idx" ON "ClubSupplyItem"("isActive", "section", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ClubSupplyStock_organizationId_itemId_key" ON "ClubSupplyStock"("organizationId", "itemId");

-- CreateIndex
CREATE INDEX "ClubSupplyStock_itemId_idx" ON "ClubSupplyStock"("itemId");

-- AddForeignKey
ALTER TABLE "ClubSupplyItem" ADD CONSTRAINT "ClubSupplyItem_honorId_fkey" FOREIGN KEY ("honorId") REFERENCES "Honor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubSupplyStock" ADD CONSTRAINT "ClubSupplyStock_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubSupplyStock" ADD CONSTRAINT "ClubSupplyStock_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ClubSupplyItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubSupplyStock" ADD CONSTRAINT "ClubSupplyStock_updatedByAccountId_fkey" FOREIGN KEY ("updatedByAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubSupplyStock" ADD CONSTRAINT "ClubSupplyStock_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
