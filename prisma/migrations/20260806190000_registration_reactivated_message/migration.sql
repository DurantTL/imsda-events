ALTER TYPE "MessageTemplateKey"
ADD VALUE IF NOT EXISTS 'REGISTRATION_REACTIVATED';

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
    'msgtpl_' || substr(md5(event."id" || ':REGISTRATION_REACTIVATED'), 1, 24),
    event."id",
    'REGISTRATION_REACTIVATED'::"MessageTemplateKey",
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
    'Registration reactivated: {{event_name}} ({{confirmation_code}})',
    E'# Registration reactivated for {{event_name}}\\n\\nHello {{recipient_name}},\\n\\nRegistration **{{confirmation_code}}** was reactivated successfully.\\n\\n- **Restored status:** {{restored_status}}\\n\\n{{attendee_summary}}\\n\\n{{payment_status_block}}\\n\\nYour prior registration total and payment and refund history were preserved. No payment was recreated by this reactivation.\\n\\nAny applicable capacity reservations were restored from the saved registration choices. No new capacity or waitlist policy was created by this reactivation.\\n\\n**[Manage your registration]({{portal_url}})**\\n\\n---\\n\\nQuestions? Contact {{contact_email}}.',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "EventMessageTemplate" template
WHERE template."key" = 'REGISTRATION_REACTIVATED'
ON CONFLICT ("templateId", "versionNumber") DO NOTHING;
