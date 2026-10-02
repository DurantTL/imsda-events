-- #741 slice 1: per-event feature modules. A row means "enabled" for one event;
-- the catalog of keys lives in code (modules/event-modules), so there is no
-- boolean column per module. Turning a module off deletes only its row here,
-- never the data behind it.

-- CreateTable
CREATE TABLE "EventModule" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "moduleKey" TEXT NOT NULL,
    "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventModule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventModule_eventId_moduleKey_key" ON "EventModule"("eventId", "moduleKey");

-- AddForeignKey
ALTER TABLE "EventModule" ADD CONSTRAINT "EventModule_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill, so nothing that works today turns off. Every rule only INSERTs;
-- the unique key makes each one idempotent. Nothing is ever deleted.

-- Public content: on for every event.
INSERT INTO "EventModule" ("id", "eventId", "moduleKey")
SELECT gen_random_uuid()::text, e."id", 'public-content' FROM "Event" e
ON CONFLICT ("eventId", "moduleKey") DO NOTHING;

-- Honors classes: events that already have honors sessions, and club-audience events.
INSERT INTO "EventModule" ("id", "eventId", "moduleKey")
SELECT gen_random_uuid()::text, e."id", 'honors' FROM "Event" e
WHERE e."audience" = 'CLUB' OR EXISTS (SELECT 1 FROM "HonorSession" h WHERE h."eventId" = e."id")
ON CONFLICT ("eventId", "moduleKey") DO NOTHING;

-- Event patches and Club assignments: club-audience events.
INSERT INTO "EventModule" ("id", "eventId", "moduleKey")
SELECT gen_random_uuid()::text, e."id", m."moduleKey" FROM "Event" e
CROSS JOIN (VALUES ('event-patches'), ('club-assignments')) AS m("moduleKey")
WHERE e."audience" = 'CLUB'
ON CONFLICT ("eventId", "moduleKey") DO NOTHING;

-- Merchandise: events that already have products (archived ones count).
INSERT INTO "EventModule" ("id", "eventId", "moduleKey")
SELECT gen_random_uuid()::text, e."id", 'merchandise' FROM "Event" e
WHERE EXISTS (SELECT 1 FROM "MerchandiseProduct" p WHERE p."eventId" = e."id")
ON CONFLICT ("eventId", "moduleKey") DO NOTHING;

-- Seminar assignments: events with a ranked-interest choice field on any form
-- version (the same test program assignments use: RANKED_CHOICE with
-- availabilityMode RANKED_INTEREST, or, when no mode is stored, choice limits),
-- and events that already ran an assignment.
INSERT INTO "EventModule" ("id", "eventId", "moduleKey")
SELECT gen_random_uuid()::text, e."id", 'seminar-assignments' FROM "Event" e
WHERE EXISTS (SELECT 1 FROM "ProgramAssignmentRun" r WHERE r."eventId" = e."id")
   OR EXISTS (
     SELECT 1 FROM "RegistrationForm" f
     JOIN "RegistrationFormVersion" v ON v."formId" = f."id"
     WHERE f."eventId" = e."id"
       AND jsonb_path_exists(
         v."definition"::jsonb,
         '$.sections[*].fields[*] ? (@.type == "RANKED_CHOICE" && (@.availabilityMode == "RANKED_INTEREST" || (!exists(@.availabilityMode) && exists(@.choiceLimits))))'
       )
   )
ON CONFLICT ("eventId", "moduleKey") DO NOTHING;

-- Attendee community: events with community enabled or any post.
INSERT INTO "EventModule" ("id", "eventId", "moduleKey")
SELECT gen_random_uuid()::text, e."id", 'attendee-community' FROM "Event" e
WHERE EXISTS (SELECT 1 FROM "EventCommunitySettings" s WHERE s."eventId" = e."id" AND s."isEnabled")
   OR EXISTS (SELECT 1 FROM "CommunityPost" p WHERE p."eventId" = e."id")
ON CONFLICT ("eventId", "moduleKey") DO NOTHING;
