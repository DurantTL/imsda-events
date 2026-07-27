-- Shirt sizes were never collected by the legacy Women's Retreat workbook, so
-- every migrated attendee arrives without one and there is no message that can
-- ask for it. This adds that message.
--
-- The body carries {{portal_url}} deliberately: the same email that asks for a
-- shirt size hands the registrant their private management link, so a migrated
-- registrant reaches self-service for the first time without a separate send.
ALTER TYPE "MessageTemplateKey" ADD VALUE IF NOT EXISTS 'SHIRT_SIZE_REQUEST';

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
    'msgtpl_' || substr(md5(event."id" || ':SHIRT_SIZE_REQUEST'), 1, 24),
    event."id",
    'SHIRT_SIZE_REQUEST'::"MessageTemplateKey",
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
    'Shirt sizes needed for {{event_name}} ({{confirmation_code}})',
    E'Hello {{recipient_name}},\n\nWe still need a shirt size for everyone on registration {{confirmation_code}} for {{event_name}}.\n\n{{attendee_summary}}\n\nOpen your private registration page to choose a size for each attendee. The same page shows your balance and lets you update your contact details:\n{{portal_url}}\n\nThis link is private to your registration. Please do not forward it.\n\nQuestions? Contact {{reply_to_email}}.',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "EventMessageTemplate" template
WHERE template."key" = 'SHIRT_SIZE_REQUEST'
ON CONFLICT ("templateId", "versionNumber") DO NOTHING;

-- One shirt-size batch per reviewed audience, matching how balance reminder
-- batches are made idempotent.
DROP INDEX IF EXISTS "AuditLog_message_operation_idempotency_key";
CREATE UNIQUE INDEX "AuditLog_message_operation_idempotency_key"
ON "AuditLog"("action", "entityId")
WHERE "action" IN (
  'BALANCE_REMINDER_BATCH_ENQUEUED',
  'REGISTRATION_CONFIRMATION_RESEND_ENQUEUED',
  'SHIRT_SIZE_REQUEST_BATCH_ENQUEUED'
) AND "entityId" IS NOT NULL;
