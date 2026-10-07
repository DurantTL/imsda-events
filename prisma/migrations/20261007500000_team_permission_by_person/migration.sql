-- A team member's permission decision belongs to the PERSON on the team (#809), not to one attendee row: a granted or declined
-- decision outlives the row, and only a pending flag is deleted when the person stops needing it.
ALTER TABLE "ClubTeamMemberPermission" ADD COLUMN "personId" TEXT;
ALTER TABLE "ClubTeamMemberPermission" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
-- Rows made before this change (development databases only) take the person from their attendee row.
UPDATE "ClubTeamMemberPermission" p SET "personId" = a."personId" FROM "RegistrationAttendee" a WHERE a."id" = p."registrationAttendeeId";
DELETE FROM "ClubTeamMemberPermission" WHERE "personId" IS NULL;
ALTER TABLE "ClubTeamMemberPermission" ALTER COLUMN "personId" SET NOT NULL;
ALTER TABLE "ClubTeamMemberPermission" ALTER COLUMN "registrationAttendeeId" DROP NOT NULL;
ALTER TABLE "ClubTeamMemberPermission" DROP CONSTRAINT "ClubTeamMemberPermission_registrationAttendeeId_fkey";
ALTER TABLE "ClubTeamMemberPermission" ADD CONSTRAINT "ClubTeamMemberPermission_registrationAttendeeId_fkey" FOREIGN KEY ("registrationAttendeeId") REFERENCES "RegistrationAttendee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
DROP INDEX "ClubTeamMemberPermission_clubEventRegistrationId_idx";
CREATE UNIQUE INDEX "ClubTeamMemberPermission_clubEventRegistrationId_personId_key" ON "ClubTeamMemberPermission"("clubEventRegistrationId", "personId");
