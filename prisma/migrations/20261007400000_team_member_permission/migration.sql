-- A team member of 18 or older on the age date needs the Area Coordinator's permission (#809): a flag on the attendee, decided by the
-- Area Coordinator or staff, and a message type for the request.

-- CreateEnum
CREATE TYPE "TeamPermissionStatus" AS ENUM ('PENDING', 'GRANTED', 'DECLINED');

-- AlterEnum
ALTER TYPE "MessageTemplateKey" ADD VALUE 'TEAM_PERMISSION_REQUEST';

-- CreateTable
CREATE TABLE "ClubTeamMemberPermission" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "clubEventRegistrationId" TEXT NOT NULL,
    "registrationAttendeeId" TEXT NOT NULL,
    "status" "TeamPermissionStatus" NOT NULL DEFAULT 'PENDING',
    "ageOnAgeDate" INTEGER NOT NULL,
    "decidedByUserId" TEXT,
    "decidedByAccountId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubTeamMemberPermission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClubTeamMemberPermission_registrationAttendeeId_key" ON "ClubTeamMemberPermission"("registrationAttendeeId");

-- CreateIndex
CREATE INDEX "ClubTeamMemberPermission_eventId_status_idx" ON "ClubTeamMemberPermission"("eventId", "status");

-- CreateIndex
CREATE INDEX "ClubTeamMemberPermission_clubEventRegistrationId_idx" ON "ClubTeamMemberPermission"("clubEventRegistrationId");

-- AddForeignKey
ALTER TABLE "ClubTeamMemberPermission" ADD CONSTRAINT "ClubTeamMemberPermission_clubEventRegistrationId_fkey" FOREIGN KEY ("clubEventRegistrationId") REFERENCES "ClubEventRegistration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubTeamMemberPermission" ADD CONSTRAINT "ClubTeamMemberPermission_registrationAttendeeId_fkey" FOREIGN KEY ("registrationAttendeeId") REFERENCES "RegistrationAttendee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubTeamMemberPermission" ADD CONSTRAINT "ClubTeamMemberPermission_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubTeamMemberPermission" ADD CONSTRAINT "ClubTeamMemberPermission_decidedByAccountId_fkey" FOREIGN KEY ("decidedByAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

