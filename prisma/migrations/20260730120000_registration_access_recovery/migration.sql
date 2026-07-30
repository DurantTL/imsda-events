ALTER TYPE "MessageTemplateKey"
ADD VALUE IF NOT EXISTS 'REGISTRATION_ACCESS_RECOVERY';

COMMIT;

ALTER TABLE "ProgramAssignmentRun"
ADD COLUMN "invalidatedAt" TIMESTAMP(3);

DROP INDEX IF EXISTS "ProgramAssignmentRun_eventId_formVersionId_fieldId_appliedAt_idx";
CREATE INDEX "ProgramAssignmentRun_eventId_formVersionId_fieldId_invalidatedAt_appliedAt_idx"
ON "ProgramAssignmentRun"("eventId", "formVersionId", "fieldId", "invalidatedAt", "appliedAt");

INSERT INTO "EventMessageTemplate" (
    "id",
    "eventId",
    "key",
    "isEnabled",
    "createdAt",
    "updatedAt"
)
SELECT
    'msgtpl_' || substr(md5(event."id" || ':REGISTRATION_ACCESS_RECOVERY'), 1, 24),
    event."id",
    'REGISTRATION_ACCESS_RECOVERY'::"MessageTemplateKey",
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
    'Your private registration link: {{event_name}} ({{confirmation_code}})',
    E'Hello {{recipient_name}},\n\nSomeone requested a new private management link for registration {{confirmation_code}} for {{event_name}}.\n\nOpen your registration:\n{{portal_url}}\n\nThis link expires and is private to your registration. Please do not forward it.\n\nIf you did not request this link, no registration details were changed and you can ignore this message.\n\nQuestions? Contact {{reply_to_email}}.',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "EventMessageTemplate" template
WHERE template."key" = 'REGISTRATION_ACCESS_RECOVERY'
ON CONFLICT ("templateId", "versionNumber") DO NOTHING;
