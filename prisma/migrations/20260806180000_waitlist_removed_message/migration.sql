ALTER TYPE "MessageTemplateKey"
ADD VALUE IF NOT EXISTS 'WAITLIST_REMOVED';

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
    'msgtpl_' || substr(md5(event."id" || ':WAITLIST_REMOVED'), 1, 24),
    event."id",
    'WAITLIST_REMOVED'::"MessageTemplateKey",
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
    'Waitlist removal confirmed: {{event_name}} ({{confirmation_code}})',
    E'# Removed from the waitlist for {{event_name}}\n\nHello {{recipient_name}},\n\nRegistration **{{confirmation_code}}** has been removed from the waitlist and cancelled.\n\n- **Previous waitlist position:** {{waitlist_position}}\n- **Reason:** {{waitlist_removal_reason}}\n\n{{payment_status_block}}\n\n**[Review the cancelled registration]({{portal_url}})**\n\n---\n\nQuestions? Contact {{contact_email}}.',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "EventMessageTemplate" template
WHERE template."key" = 'WAITLIST_REMOVED'
ON CONFLICT ("templateId", "versionNumber") DO NOTHING;
