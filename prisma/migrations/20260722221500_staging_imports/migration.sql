-- CreateEnum
CREATE TYPE "ImportRecordStatus" AS ENUM ('READY', 'WARNING', 'ERROR', 'CREATED', 'UPDATED', 'SKIPPED');

-- AlterEnum
ALTER TYPE "EventPermission" ADD VALUE 'MANAGE_IMPORTS';

-- AlterTable
ALTER TABLE "ImportRun" ADD COLUMN "fileName" TEXT,
ADD COLUMN "sourceChecksum" TEXT;

-- CreateTable
CREATE TABLE "ImportRecord" (
    "id" TEXT NOT NULL,
    "importRunId" TEXT NOT NULL,
    "sourceRow" INTEGER NOT NULL,
    "sourceRecordKey" TEXT NOT NULL,
    "confirmationCode" TEXT,
    "status" "ImportRecordStatus" NOT NULL,
    "proposedAction" TEXT NOT NULL,
    "matchedPersonId" TEXT,
    "matchedRegistrationId" TEXT,
    "committedEntityId" TEXT,
    "rawSnapshot" JSONB NOT NULL,
    "normalizedData" JSONB,
    "differences" JSONB,
    "warnings" JSONB,
    "errors" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ImportRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ImportRecord_importRunId_status_idx" ON "ImportRecord"("importRunId", "status");
CREATE INDEX "ImportRecord_sourceRecordKey_idx" ON "ImportRecord"("sourceRecordKey");
CREATE UNIQUE INDEX "ImportRecord_importRunId_sourceRow_key" ON "ImportRecord"("importRunId", "sourceRow");

ALTER TABLE "ImportRecord" ADD CONSTRAINT "ImportRecord_importRunId_fkey" FOREIGN KEY ("importRunId") REFERENCES "ImportRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
