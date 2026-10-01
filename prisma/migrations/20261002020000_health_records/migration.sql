-- Pathfinder Health Record (#611): encrypted per-field health records, and single-use parent links. Additive only; nothing is read or written unless HEALTH_RECORDS_ENABLED=true.
-- The outbox template key for the parent's private link email, and the
-- separately granted staff permission (also added by the coordinator health
-- view, #658, hence IF NOT EXISTS so either may merge first). Neither value is
-- used inside this migration.
ALTER TYPE "MessageTemplateKey" ADD VALUE 'HEALTH_RECORD_LINK';
ALTER TYPE "EventPermission" ADD VALUE IF NOT EXISTS 'VIEW_HEALTH_INFORMATION';

-- CreateEnum
CREATE TYPE "HealthRecordLinkStatus" AS ENUM ('OPEN', 'USED', 'REVOKED');

-- CreateEnum
CREATE TYPE "HealthRecordEntryChannel" AS ENUM ('DIRECTOR', 'LINK');

-- CreateTable
CREATE TABLE "HealthRecord" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "rosterMemberId" TEXT NOT NULL,
    "confirmedClubYear" TEXT,
    "hasHealthNote" BOOLEAN NOT NULL DEFAULT false,
    "lastEnteredVia" "HealthRecordEntryChannel",
    "lastSavedByActor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealthRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthRecordField" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "sealedValue" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealthRecordField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthRecordLink" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "rosterMemberId" TEXT NOT NULL,
    "clubYear" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "status" "HealthRecordLinkStatus" NOT NULL DEFAULT 'OPEN',
    "tokenHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "messageId" TEXT,
    "createdByActor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealthRecordLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HealthRecord_rosterMemberId_key" ON "HealthRecord"("rosterMemberId");

-- CreateIndex
CREATE INDEX "HealthRecord_organizationId_idx" ON "HealthRecord"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "HealthRecordField_recordId_fieldKey_key" ON "HealthRecordField"("recordId", "fieldKey");

-- CreateIndex
CREATE UNIQUE INDEX "HealthRecordLink_tokenHash_key" ON "HealthRecordLink"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "HealthRecordLink_messageId_key" ON "HealthRecordLink"("messageId");

-- CreateIndex
CREATE INDEX "HealthRecordLink_organizationId_status_idx" ON "HealthRecordLink"("organizationId", "status");

-- CreateIndex
CREATE INDEX "HealthRecordLink_rosterMemberId_idx" ON "HealthRecordLink"("rosterMemberId");

-- CreateIndex
CREATE INDEX "HealthRecordLink_status_expiresAt_idx" ON "HealthRecordLink"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "HealthRecord" ADD CONSTRAINT "HealthRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthRecord" ADD CONSTRAINT "HealthRecord_rosterMemberId_fkey" FOREIGN KEY ("rosterMemberId") REFERENCES "ClubRosterMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthRecordField" ADD CONSTRAINT "HealthRecordField_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "HealthRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthRecordLink" ADD CONSTRAINT "HealthRecordLink_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthRecordLink" ADD CONSTRAINT "HealthRecordLink_rosterMemberId_fkey" FOREIGN KEY ("rosterMemberId") REFERENCES "ClubRosterMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

