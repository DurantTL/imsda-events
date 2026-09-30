-- eAdventist organizations import (#649). Additive only: new organization
-- kinds, and nullable columns on "Organization", so every existing church and
-- club behaves exactly as before. Hand-written; matches `prisma migrate diff`.

-- AlterEnum
ALTER TYPE "OrganizationType" ADD VALUE 'COMPANY';
ALTER TYPE "OrganizationType" ADD VALUE 'GROUP';
ALTER TYPE "OrganizationType" ADD VALUE 'SCHOOL';
ALTER TYPE "OrganizationType" ADD VALUE 'EARLY_CHILDHOOD';
ALTER TYPE "OrganizationType" ADD VALUE 'BOOKSTORE';
ALTER TYPE "OrganizationType" ADD VALUE 'COMMUNITY_CENTER';
ALTER TYPE "OrganizationType" ADD VALUE 'CAMP';
ALTER TYPE "OrganizationType" ADD VALUE 'CONFERENCE';
ALTER TYPE "OrganizationType" ADD VALUE 'ASSOCIATION';

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "eadventistId" TEXT,
ADD COLUMN     "orgCode" TEXT,
ADD COLUMN     "sourceOrgType" TEXT,
ADD COLUMN     "streetAddress" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "state" TEXT,
ADD COLUMN     "postalCode" TEXT,
ADD COLUMN     "website" TEXT,
ADD COLUMN     "officePhone" TEXT,
ADD COLUMN     "district" TEXT,
ADD COLUMN     "language" TEXT,
ADD COLUMN     "disbandedOn" DATE,
ADD COLUMN     "affiliatedOrganizationId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Organization_eadventistId_key" ON "Organization"("eadventistId");

-- CreateIndex
CREATE INDEX "Organization_affiliatedOrganizationId_idx" ON "Organization"("affiliatedOrganizationId");

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_affiliatedOrganizationId_fkey" FOREIGN KEY ("affiliatedOrganizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
