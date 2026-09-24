-- Q1 (#426): club meeting notes, and a draft/submitted state on monthly
-- reports so it's clear whether a report is only saved or actually filed.

-- CreateEnum
CREATE TYPE "ClubReportStatus" AS ENUM ('DRAFT', 'SUBMITTED');

-- AlterTable: add status columns, defaulting to DRAFT for future inserts.
ALTER TABLE "ClubMonthlyReport" ADD COLUMN "status" "ClubReportStatus" NOT NULL DEFAULT 'DRAFT';
ALTER TABLE "ClubMonthlyReport" ADD COLUMN "submittedAt" TIMESTAMP(3);

-- Every report filed before this change was submitted under the old
-- single-button form: mark them SUBMITTED, with submittedAt set to the
-- moment they were first submitted, so nothing already filed looks like a
-- draft to staff or an Area Coordinator.
UPDATE "ClubMonthlyReport" SET "status" = 'SUBMITTED', "submittedAt" = "firstSubmittedAt";

-- firstSubmittedAt now only holds a value once a report has actually been
-- submitted at least once (a draft that was never submitted has none).
ALTER TABLE "ClubMonthlyReport" ALTER COLUMN "firstSubmittedAt" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "ClubMonthlyReport_clubYear_status_idx" ON "ClubMonthlyReport"("clubYear", "status");

-- CreateTable
CREATE TABLE "ClubMeetingNote" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "meetingDate" TEXT NOT NULL,
    "pathfinderCount" INTEGER,
    "tltCount" INTEGER,
    "staffCount" INTEGER,
    "honors" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT NOT NULL DEFAULT '',
    "createdByAccountId" TEXT,
    "updatedByAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubMeetingNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClubMeetingNote_organizationId_meetingDate_idx" ON "ClubMeetingNote"("organizationId", "meetingDate");

-- AddForeignKey
ALTER TABLE "ClubMeetingNote" ADD CONSTRAINT "ClubMeetingNote_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
