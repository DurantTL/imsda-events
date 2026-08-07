ALTER TYPE "MessageTemplateKey"
ADD VALUE IF NOT EXISTS 'REFUND_NOTICE';

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
    'msgtpl_' || substr(md5(event."id" || ':REFUND_NOTICE'), 1, 24),
    event."id",
    'REFUND_NOTICE'::"MessageTemplateKey",
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
    'Refund recorded: {{event_name}} ({{confirmation_code}})',
    E'# Refund recorded for {{event_name}}\\n\\nHello {{recipient_name}},\\n\\nA refund was recorded for registration **{{confirmation_code}}**.\\n\\n- **Refunded amount:** {{refund_amount}}\\n- **Remaining balance:** {{balance_amount}}\\n- **Reference:** {{refund_reference}}\\n\\nThis notice confirms the recorded refund only; it does not make claims about processor fees or other fee-refund policy.\\n\\n**[Review your registration and payment history]({{portal_url}})**\\n\\n---\\n\\nQuestions? Contact {{contact_email}}.',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "EventMessageTemplate" template
WHERE template."key" = 'REFUND_NOTICE'
ON CONFLICT ("templateId", "versionNumber") DO NOTHING;
