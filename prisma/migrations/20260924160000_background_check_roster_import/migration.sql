-- CreateEnum
CREATE TYPE "BackgroundCheckComplianceStatus" AS ENUM ('CLEAR', 'NEEDS_ATTENTION');

-- AlterEnum
ALTER TYPE "ExternalSystem" ADD VALUE 'ROSTER_IMPORT';

-- AlterTable
ALTER TABLE "BackgroundCheck"
  ALTER COLUMN "expiresOn" DROP NOT NULL,
  ADD COLUMN "complianceStatus" "BackgroundCheckComplianceStatus",
  ADD COLUMN "issuesNote" TEXT,
  ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
