-- CreateEnum
CREATE TYPE "BackgroundCheckComplianceStatus" AS ENUM ('CLEAR', 'FLAGGED', 'NOT_COMPLIANT');

-- AlterEnum
ALTER TYPE "ExternalSystem" ADD VALUE 'ROSTER_IMPORT';

-- AlterTable
ALTER TABLE "BackgroundCheck"
  ALTER COLUMN "expiresOn" DROP NOT NULL,
  ADD COLUMN "complianceStatus" "BackgroundCheckComplianceStatus",
  ADD COLUMN "issuesNote" TEXT,
  ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
