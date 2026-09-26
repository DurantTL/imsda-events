-- Q1 (#442): staff "act as" Area Coordinator / club director moves to a
-- record tied to the staff session, never to the staff member's own
-- attendee account (the accounts stay separate, decisions 2026-09-25/27).

-- CreateEnum
CREATE TYPE "StaffActAsRole" AS ENUM ('AREA_COORDINATOR', 'CLUB_DIRECTOR');

-- CreateEnum
CREATE TYPE "StaffActAsEndReason" AS ENUM ('STOPPED', 'REPLACED', 'SIGNED_OUT', 'EXPIRED');

-- CreateTable
CREATE TABLE "StaffActAs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "staffSessionId" TEXT NOT NULL,
    "role" "StaffActAsRole" NOT NULL,
    "organizationId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endedReason" "StaffActAsEndReason",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffActAs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StaffActAs_userId_idx" ON "StaffActAs"("userId");

-- CreateIndex
CREATE INDEX "StaffActAs_staffSessionId_endedAt_idx" ON "StaffActAs"("staffSessionId", "endedAt");

-- CreateIndex
CREATE INDEX "StaffActAs_organizationId_idx" ON "StaffActAs"("organizationId");

-- Only one active (endedAt IS NULL) act-as per staff session, enforced at
-- the database level so a race between two "start" requests can't leave two
-- active rows even if the application-level transaction were ever skipped.
-- CreateIndex
CREATE UNIQUE INDEX "StaffActAs_staffSessionId_active_key" ON "StaffActAs"("staffSessionId") WHERE "endedAt" IS NULL;

-- AddForeignKey
ALTER TABLE "StaffActAs" ADD CONSTRAINT "StaffActAs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffActAs" ADD CONSTRAINT "StaffActAs_staffSessionId_fkey" FOREIGN KEY ("staffSessionId") REFERENCES "UserSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffActAs" ADD CONSTRAINT "StaffActAs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Attribution columns (#442): a sibling *ByUserId next to each existing
-- *ByAccountId, so a staff "act as" director's changes are recorded against
-- the staff user, never credited to an attendee account that didn't act.

-- AlterTable
ALTER TABLE "ClubMeetingNote" ADD COLUMN     "createdByUserId" TEXT,
ADD COLUMN     "updatedByUserId" TEXT;

-- AlterTable
ALTER TABLE "ClubRosterMember" ADD COLUMN     "createdByUserId" TEXT;

-- AlterTable
ALTER TABLE "ClubEventRegistration" ADD COLUMN     "submittedByUserId" TEXT;

-- AlterTable
ALTER TABLE "ClubRegistrationDraft" ADD COLUMN     "updatedByUserId" TEXT;

-- AddForeignKey
ALTER TABLE "ClubMeetingNote" ADD CONSTRAINT "ClubMeetingNote_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubMeetingNote" ADD CONSTRAINT "ClubMeetingNote_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubRosterMember" ADD CONSTRAINT "ClubRosterMember_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubEventRegistration" ADD CONSTRAINT "ClubEventRegistration_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubRegistrationDraft" ADD CONSTRAINT "ClubRegistrationDraft_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
