-- How a team did at each level of a multi-level event (#809): the Area, Conference and Union levels of the Pathfinder Bible
-- Experience. The Conference and Union levels are not registrations, so their results sit beside the team's one registration.
-- A new table only; nothing existing is touched.

CREATE TYPE "TeamResultLevel" AS ENUM ('AREA', 'CONFERENCE', 'UNION');

CREATE TABLE "ClubTeamResult" (
    "id" TEXT NOT NULL,
    "clubEventRegistrationId" TEXT NOT NULL,
    "level" "TeamResultLevel" NOT NULL,
    "placement" TEXT NOT NULL DEFAULT '',
    "qualified" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT NOT NULL DEFAULT '',
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubTeamResult_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClubTeamResult_clubEventRegistrationId_level_key" ON "ClubTeamResult"("clubEventRegistrationId", "level");

ALTER TABLE "ClubTeamResult" ADD CONSTRAINT "ClubTeamResult_clubEventRegistrationId_fkey" FOREIGN KEY ("clubEventRegistrationId") REFERENCES "ClubEventRegistration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClubTeamResult" ADD CONSTRAINT "ClubTeamResult_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
