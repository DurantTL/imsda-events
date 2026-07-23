INSERT INTO "EventMessageTemplate" (
    "id",
    "eventId",
    "key",
    "isEnabled",
    "createdAt",
    "updatedAt"
)
SELECT
    'msgtpl_' || substr(md5(event."id" || ':BALANCE_REMINDER'), 1, 24),
    event."id",
    'BALANCE_REMINDER'::"MessageTemplateKey",
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
    'Payment reminder: {{event_name}} — {{balance_amount}} due',
    E'Hello {{recipient_name}},\n\nThis is a reminder that registration {{confirmation_code}} for {{event_name}} has a balance remaining.\n\nRegistration total: {{total_amount}}\nBalance due: {{balance_amount}}\n\nReview your registration or continue payment:\n{{portal_url}}\n\nIf you recently made a payment, it may still be processing. Questions? Contact {{reply_to_email}}.',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "EventMessageTemplate" template
WHERE template."key" = 'BALANCE_REMINDER'
ON CONFLICT ("templateId", "versionNumber") DO NOTHING;

-- Batch and resend audit rows use stable operation IDs. This partial index
-- makes their audit write as idempotent as the outbox rows themselves.
CREATE UNIQUE INDEX "AuditLog_message_operation_idempotency_key"
ON "AuditLog"("action", "entityId")
WHERE "action" IN (
  'BALANCE_REMINDER_BATCH_ENQUEUED',
  'REGISTRATION_CONFIRMATION_RESEND_ENQUEUED'
) AND "entityId" IS NOT NULL;

-- A different client request ID must not create a second live resend while
-- the first copy is still queued or being processed. Terminal history remains
-- available and staff may explicitly create a later resend after it finishes.
CREATE UNIQUE INDEX "MessageOutbox_active_confirmation_resend_source_key"
ON "MessageOutbox"("retryOfMessageId")
WHERE "retryOfMessageId" IS NOT NULL
  AND "status" IN ('PENDING', 'PROCESSING')
  AND "metadata"->>'trigger' = 'STAFF_CONFIRMATION_RESEND';
