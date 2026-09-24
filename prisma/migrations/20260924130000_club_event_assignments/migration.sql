-- Q1 (#410): club event assignments (campsite, duty, activity) and the
-- assignment email that tells a club director what staff set.
--
-- Kept as its own table, one row per ClubEventRegistration, separate from the
-- club's submitted preferences (PublicRegistrationSubmission /
-- ClubRegistrationDraft): staff assignments and a club's own answers must
-- never overwrite each other. Simple and replaceable by the general grouping
-- engine (#89) if that lands later.

-- AlterEnum
ALTER TYPE "MessageTemplateKey" ADD VALUE IF NOT EXISTS 'CLUB_ASSIGNMENTS';

-- CreateTable
CREATE TABLE "ClubEventAssignment" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clubEventRegistrationId" TEXT NOT NULL,
    "campsiteLocation" TEXT NOT NULL DEFAULT '',
    "campsiteNotes" TEXT NOT NULL DEFAULT '',
    "dutyLabel" TEXT NOT NULL DEFAULT '',
    "dutyDay" TEXT NOT NULL DEFAULT '',
    "dutyTime" TEXT NOT NULL DEFAULT '',
    "activityLabel" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "lastEmailSentAt" TIMESTAMP(3),
    "lastEmailedVersion" INTEGER,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubEventAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClubEventAssignment_clubEventRegistrationId_key" ON "ClubEventAssignment"("clubEventRegistrationId");

-- CreateIndex
CREATE UNIQUE INDEX "ClubEventAssignment_eventId_organizationId_key" ON "ClubEventAssignment"("eventId", "organizationId");

-- CreateIndex
CREATE INDEX "ClubEventAssignment_eventId_updatedAt_idx" ON "ClubEventAssignment"("eventId", "updatedAt");

-- AddForeignKey
ALTER TABLE "ClubEventAssignment" ADD CONSTRAINT "ClubEventAssignment_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubEventAssignment" ADD CONSTRAINT "ClubEventAssignment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubEventAssignment" ADD CONSTRAINT "ClubEventAssignment_clubEventRegistrationId_fkey" FOREIGN KEY ("clubEventRegistrationId") REFERENCES "ClubEventRegistration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubEventAssignment" ADD CONSTRAINT "ClubEventAssignment_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;

-- Seed the CLUB_ASSIGNMENTS template for every existing event, matching how
-- SHIRT_SIZE_REQUEST (20260727210000) backfilled events that predate a new
-- message. `ALTER TYPE ... ADD VALUE` cannot run in the same transaction as a
-- statement that uses the new value, hence the COMMIT above. The subject and
-- body are identical to DEFAULT_MESSAGE_TEMPLATES.CLUB_ASSIGNMENTS
-- (tests/message-templates.test.ts asserts this), so a backfilled event and a
-- newly created one send the same words.
INSERT INTO "EventMessageTemplate" (
    "id",
    "eventId",
    "key",
    "isEnabled",
    "createdAt",
    "updatedAt"
)
SELECT
    'msgtpl_' || substr(md5(event."id" || ':CLUB_ASSIGNMENTS'), 1, 24),
    event."id",
    'CLUB_ASSIGNMENTS'::"MessageTemplateKey",
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Event" event
ON CONFLICT ("eventId", "key") DO NOTHING;

INSERT INTO "MessageTemplateVersion" (
    "id",
    "templateId",
    "createdByUserId",
    "versionNumber",
    "status",
    "subjectTemplate",
    "bodyTemplate",
    "publishedAt",
    "createdAt",
    "updatedAt"
)
SELECT
    'msgver_' || substr(md5(template."id" || ':1'), 1, 24),
    template."id",
    NULL,
    1,
    'PUBLISHED',
    'Your club''s assignments for {{event_name}}',
    E'# Your club''s assignments for {{event_name}}\n\nHello {{recipient_name}},\n\nHere is what staff have set for registration **{{confirmation_code}}**:\n\n{{club_assignments_block}}\n\n**[Open your club''s event page]({{portal_url}})**\n\n---\n\nQuestions? Contact {{contact_email}}.',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "EventMessageTemplate" template
WHERE template."key" = 'CLUB_ASSIGNMENTS'
ON CONFLICT ("templateId", "versionNumber") DO NOTHING;

-- One assignment-email batch per reviewed audience, matching how the other
-- staff-reviewed batches are made idempotent against a double click.
DROP INDEX IF EXISTS "AuditLog_message_operation_idempotency_key";
CREATE UNIQUE INDEX "AuditLog_message_operation_idempotency_key"
ON "AuditLog"("action", "entityId")
WHERE "action" IN (
  'BALANCE_REMINDER_BATCH_ENQUEUED',
  'REGISTRATION_CONFIRMATION_RESEND_ENQUEUED',
  'SHIRT_SIZE_REQUEST_BATCH_ENQUEUED',
  'CLUB_ASSIGNMENTS_BATCH_ENQUEUED'
) AND "entityId" IS NOT NULL;
