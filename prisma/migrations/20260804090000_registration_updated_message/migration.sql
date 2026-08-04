ALTER TYPE "MessageTemplateKey"
ADD VALUE IF NOT EXISTS 'REGISTRATION_UPDATED';

COMMIT;

INSERT INTO "EventMessageTemplate" (
    "id",
    "eventId",
    "key",
    "isEnabled",
    "createdAt",
    "updatedAt"
)
SELECT
    'msgtpl_' || substr(md5(event."id" || ':REGISTRATION_UPDATED'), 1, 24),
    event."id",
    'REGISTRATION_UPDATED'::"MessageTemplateKey",
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
    'Registration updated: {{event_name}}',
    E'# Registration updated for {{event_name}}\n\nHello {{recipient_name}},\n\nRegistration **{{confirmation_code}}** was updated successfully.\n\n- **Change category:** {{change_category}}\n\nFor your privacy, this confirmation does not include submitted answer values.\n\n**[Review your registration]({{portal_url}})**\n\n---\n\nQuestions? Contact {{contact_email}}.',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "EventMessageTemplate" template
WHERE template."key" = 'REGISTRATION_UPDATED'
ON CONFLICT ("templateId", "versionNumber") DO NOTHING;
