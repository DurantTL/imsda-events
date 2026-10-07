-- Public event page content blocks (#816). Additive only: eleven new section
-- kinds, one column that defaults, and a join table for the images a block
-- shows. Every existing section keeps meaning what it meant. No data is moved.

-- AlterEnum (PostgreSQL 12+ allows this in a transaction; the new values are not used here)
ALTER TYPE "EventContentSectionKind" ADD VALUE 'HERO';
ALTER TYPE "EventContentSectionKind" ADD VALUE 'IMAGE';
ALTER TYPE "EventContentSectionKind" ADD VALUE 'GALLERY';
ALTER TYPE "EventContentSectionKind" ADD VALUE 'FORMATTED_TEXT';
ALTER TYPE "EventContentSectionKind" ADD VALUE 'EMBED';
ALTER TYPE "EventContentSectionKind" ADD VALUE 'FAQ';
ALTER TYPE "EventContentSectionKind" ADD VALUE 'CUSTOM_HTML';
ALTER TYPE "EventContentSectionKind" ADD VALUE 'SCHEDULE';
ALTER TYPE "EventContentSectionKind" ADD VALUE 'SPEAKERS';
ALTER TYPE "EventContentSectionKind" ADD VALUE 'CONTACT';
ALTER TYPE "EventContentSectionKind" ADD VALUE 'COUNTDOWN';

-- AlterTable
ALTER TABLE "EventContentSection" ADD COLUMN "data" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "EventContentSectionAsset" (
    "sectionId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,

    CONSTRAINT "EventContentSectionAsset_pkey" PRIMARY KEY ("sectionId","assetId")
);

-- CreateIndex
CREATE INDEX "EventContentSectionAsset_assetId_idx" ON "EventContentSectionAsset"("assetId");

-- AddForeignKey
ALTER TABLE "EventContentSectionAsset" ADD CONSTRAINT "EventContentSectionAsset_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "EventContentSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventContentSectionAsset" ADD CONSTRAINT "EventContentSectionAsset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "EventAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
