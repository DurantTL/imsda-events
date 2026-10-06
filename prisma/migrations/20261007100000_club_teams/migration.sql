-- Club teams (#809). An event can let a club register more than one team, each with its own name; the Pathfinder Bible
-- Experience is the first. Nothing existing changes: every current registration, draft and assignment keeps the empty team
-- key, and an event without team settings keeps today's rule of one registration per club.

-- Team rules for an event: one row per event that uses teams.
CREATE TABLE "EventTeamSettings" (
    "eventId" TEXT NOT NULL,
    "allowMultipleTeams" BOOLEAN NOT NULL DEFAULT false,
    "minTeamMembers" INTEGER,
    "maxTeamMembers" INTEGER,
    "maxAlternates" INTEGER NOT NULL DEFAULT 0,
    "ageAsOf" TEXT,
    "maxMemberAge" INTEGER,
    "booksLine" TEXT NOT NULL DEFAULT '',
    "levelInfo" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventTeamSettings_pkey" PRIMARY KEY ("eventId")
);

ALTER TABLE "EventTeamSettings" ADD CONSTRAINT "EventTeamSettings_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EventTeamSettings" ADD CONSTRAINT "EventTeamSettings_limits_check" CHECK (
    ("minTeamMembers" IS NULL OR "minTeamMembers" >= 1)
    AND ("maxTeamMembers" IS NULL OR "maxTeamMembers" >= 1)
    AND ("minTeamMembers" IS NULL OR "maxTeamMembers" IS NULL OR "minTeamMembers" <= "maxTeamMembers")
    AND "maxAlternates" >= 0
    AND ("maxMemberAge" IS NULL OR "maxMemberAge" >= 0)
    AND ("ageAsOf" IS NULL OR "ageAsOf" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);

-- A club registration: the team's name and its normalized key. Every existing row takes the empty key, so the old rule of
-- one registration per club and event is the new key's rule for them.
ALTER TABLE "ClubEventRegistration" ADD COLUMN "teamName" TEXT;
ALTER TABLE "ClubEventRegistration" ADD COLUMN "teamKey" TEXT NOT NULL DEFAULT '';

ALTER TABLE "ClubEventRegistration" ADD CONSTRAINT "ClubEventRegistration_team_check" CHECK (("teamKey" = '') = ("teamName" IS NULL));

DROP INDEX "ClubEventRegistration_eventId_organizationId_key";
CREATE UNIQUE INDEX "ClubEventRegistration_eventId_organizationId_teamKey_key" ON "ClubEventRegistration"("eventId", "organizationId", "teamKey");

-- A team's name is unique within the whole event (case and spacing aside), whichever club registers it. Prisma can not
-- model a partial index, and `migrate diff` leaves one alone.
CREATE UNIQUE INDEX "ClubEventRegistration_event_team_name_key" ON "ClubEventRegistration"("eventId", "teamKey") WHERE "teamKey" <> '';

-- A club's saved drafts: one per team being registered. The existing draft keeps the empty draft key.
ALTER TABLE "ClubRegistrationDraft" ADD COLUMN "draftKey" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ClubRegistrationDraft" ADD COLUMN "teamName" TEXT NOT NULL DEFAULT '';

DROP INDEX "ClubRegistrationDraft_eventId_organizationId_key";
CREATE UNIQUE INDEX "ClubRegistrationDraft_eventId_organizationId_draftKey_key" ON "ClubRegistrationDraft"("eventId", "organizationId", "draftKey");

-- Staff's assignment belongs to one registration (its `clubEventRegistrationId` stays unique), so a club with several teams
-- has one per team; (event, club) is no longer a key.
DROP INDEX "ClubEventAssignment_eventId_organizationId_key";
CREATE INDEX "ClubEventAssignment_eventId_organizationId_idx" ON "ClubEventAssignment"("eventId", "organizationId");
