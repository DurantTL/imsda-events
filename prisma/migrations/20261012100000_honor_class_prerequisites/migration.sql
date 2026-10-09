-- Honors Weekend class prerequisites (#832). Additive only: one nullable column
-- on the class, a table of required honors, and four columns on the enrollment
-- that record how a youth who did not clearly meet a rule was placed.

-- AlterTable
ALTER TABLE "HonorOffering" ADD COLUMN "minimumClassLevel" "ClubClassLevel";

-- AlterTable
ALTER TABLE "HonorEnrollment"
  ADD COLUMN "levelConfirmedByDirector" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "prerequisitesConfirmedByDirector" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "requirementOverrideReason" TEXT,
  ADD COLUMN "requirementOverriddenByUserId" TEXT;

-- AddForeignKey
ALTER TABLE "HonorEnrollment" ADD CONSTRAINT "HonorEnrollment_requirementOverriddenByUserId_fkey" FOREIGN KEY ("requirementOverriddenByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "HonorOfferingPrerequisite" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "honorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HonorOfferingPrerequisite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HonorOfferingPrerequisite_offeringId_honorId_key" ON "HonorOfferingPrerequisite"("offeringId", "honorId");
CREATE INDEX "HonorOfferingPrerequisite_honorId_idx" ON "HonorOfferingPrerequisite"("honorId");

-- AddForeignKey
ALTER TABLE "HonorOfferingPrerequisite" ADD CONSTRAINT "HonorOfferingPrerequisite_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "HonorOffering"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HonorOfferingPrerequisite" ADD CONSTRAINT "HonorOfferingPrerequisite_honorId_fkey" FOREIGN KEY ("honorId") REFERENCES "Honor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
