CREATE TYPE "MessageTemplateKey" AS ENUM (
    'REGISTRATION_CONFIRMATION_PAID',
    'REGISTRATION_CONFIRMATION_UNPAID',
    'WORKER_CONFIRMATION',
    'INTERNAL_NEW_REGISTRATION'
);

CREATE TYPE "MessageTemplateStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "MessageDeliveryMode" AS ENUM ('DISABLED', 'LOCAL_CAPTURE');
CREATE TYPE "MessageRecipientKind" AS ENUM ('REGISTRANT', 'INTERNAL', 'TEST');
CREATE TYPE "MessageOutboxStatus" AS ENUM (
    'PENDING',
    'PROCESSING',
    'CAPTURED',
    'SENT',
    'FAILED',
    'SUPPRESSED',
    'CANCELLED'
);
CREATE TYPE "MessageAttemptStatus" AS ENUM ('CAPTURED', 'SENT', 'FAILED');

CREATE TABLE "EventMessageSettings" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "deliveryMode" "MessageDeliveryMode" NOT NULL DEFAULT 'LOCAL_CAPTURE',
    "senderName" TEXT NOT NULL,
    "senderEmail" TEXT,
    "replyToEmail" TEXT,
    "internalNotificationEmails" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EventMessageSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EventMessageTemplate" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "key" "MessageTemplateKey" NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EventMessageTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MessageTemplateVersion" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "versionNumber" INTEGER NOT NULL,
    "status" "MessageTemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "subjectTemplate" TEXT NOT NULL,
    "bodyTemplate" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MessageTemplateVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MessageOutbox" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "registrationId" TEXT,
    "templateVersionId" TEXT,
    "templateKey" "MessageTemplateKey" NOT NULL,
    "recipientKind" "MessageRecipientKind" NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "recipientName" TEXT,
    "senderNameSnapshot" TEXT NOT NULL,
    "senderEmailSnapshot" TEXT,
    "replyToEmailSnapshot" TEXT,
    "subjectSnapshot" TEXT NOT NULL,
    "bodyTextSnapshot" TEXT NOT NULL,
    "metadata" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "status" "MessageOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lockToken" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "capturedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "lastError" TEXT,
    "retryOfMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MessageOutbox_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MessageDeliveryAttempt" (
    "id" TEXT NOT NULL,
    "messageOutboxId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "MessageAttemptStatus" NOT NULL,
    "providerMessageId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "providerMetadata" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "MessageDeliveryAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EventMessageSettings_eventId_key" ON "EventMessageSettings"("eventId");
CREATE UNIQUE INDEX "EventMessageTemplate_eventId_key_key" ON "EventMessageTemplate"("eventId", "key");
CREATE INDEX "EventMessageTemplate_eventId_updatedAt_idx" ON "EventMessageTemplate"("eventId", "updatedAt");
CREATE UNIQUE INDEX "MessageTemplateVersion_templateId_versionNumber_key" ON "MessageTemplateVersion"("templateId", "versionNumber");
CREATE INDEX "MessageTemplateVersion_templateId_status_versionNumber_idx" ON "MessageTemplateVersion"("templateId", "status", "versionNumber");
CREATE UNIQUE INDEX "MessageTemplateVersion_one_published_per_template" ON "MessageTemplateVersion"("templateId") WHERE "status" = 'PUBLISHED';
CREATE UNIQUE INDEX "MessageTemplateVersion_one_draft_per_template" ON "MessageTemplateVersion"("templateId") WHERE "status" = 'DRAFT';
CREATE UNIQUE INDEX "MessageOutbox_idempotencyKey_key" ON "MessageOutbox"("idempotencyKey");
CREATE INDEX "MessageOutbox_status_availableAt_createdAt_idx" ON "MessageOutbox"("status", "availableAt", "createdAt");
CREATE INDEX "MessageOutbox_eventId_createdAt_idx" ON "MessageOutbox"("eventId", "createdAt");
CREATE INDEX "MessageOutbox_registrationId_createdAt_idx" ON "MessageOutbox"("registrationId", "createdAt");
CREATE INDEX "MessageOutbox_retryOfMessageId_idx" ON "MessageOutbox"("retryOfMessageId");
CREATE UNIQUE INDEX "MessageDeliveryAttempt_messageOutboxId_attemptNumber_key" ON "MessageDeliveryAttempt"("messageOutboxId", "attemptNumber");
CREATE INDEX "MessageDeliveryAttempt_status_startedAt_idx" ON "MessageDeliveryAttempt"("status", "startedAt");

ALTER TABLE "EventMessageSettings" ADD CONSTRAINT "EventMessageSettings_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventMessageTemplate" ADD CONSTRAINT "EventMessageTemplate_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageTemplateVersion" ADD CONSTRAINT "MessageTemplateVersion_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "EventMessageTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageTemplateVersion" ADD CONSTRAINT "MessageTemplateVersion_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MessageOutbox" ADD CONSTRAINT "MessageOutbox_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageOutbox" ADD CONSTRAINT "MessageOutbox_registrationId_fkey"
    FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MessageOutbox" ADD CONSTRAINT "MessageOutbox_templateVersionId_fkey"
    FOREIGN KEY ("templateVersionId") REFERENCES "MessageTemplateVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MessageOutbox" ADD CONSTRAINT "MessageOutbox_retryOfMessageId_fkey"
    FOREIGN KEY ("retryOfMessageId") REFERENCES "MessageOutbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MessageDeliveryAttempt" ADD CONSTRAINT "MessageDeliveryAttempt_messageOutboxId_fkey"
    FOREIGN KEY ("messageOutboxId") REFERENCES "MessageOutbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "EventMessageSettings" (
    "id",
    "eventId",
    "deliveryMode",
    "senderName",
    "senderEmail",
    "replyToEmail",
    "internalNotificationEmails",
    "createdAt",
    "updatedAt"
)
SELECT
    'msgset_' || substr(md5("id"), 1, 24),
    "id",
    'LOCAL_CAPTURE',
    'IMSDA Events',
    NULL,
    NULL,
    '[]',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Event";

INSERT INTO "EventMessageTemplate" (
    "id",
    "eventId",
    "key",
    "isEnabled",
    "createdAt",
    "updatedAt"
)
SELECT
    'msgtpl_' || substr(md5(event."id" || ':' || template."key"), 1, 24),
    event."id",
    template."key"::"MessageTemplateKey",
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Event" event
CROSS JOIN (
    VALUES
        ('REGISTRATION_CONFIRMATION_PAID'),
        ('REGISTRATION_CONFIRMATION_UNPAID'),
        ('WORKER_CONFIRMATION'),
        ('INTERNAL_NEW_REGISTRATION')
) AS template("key");

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
    CASE template."key"
        WHEN 'REGISTRATION_CONFIRMATION_PAID' THEN 'Registration confirmed - {{event_name}}'
        WHEN 'REGISTRATION_CONFIRMATION_UNPAID' THEN 'Registration received - {{event_name}}'
        WHEN 'WORKER_CONFIRMATION' THEN 'Thank you for serving at {{event_name}}'
        ELSE 'New registration: {{registrant_name}} - {{event_name}}'
    END,
    CASE template."key"
        WHEN 'REGISTRATION_CONFIRMATION_PAID' THEN E'Hello {{recipient_name}},\n\nYour registration for {{event_name}} is confirmed.\n\nConfirmation: {{confirmation_code}}\nEvent: {{event_dates}}\nLocation: {{event_location}}\nTotal: {{total_amount}}\nBalance due: {{balance_amount}}\n\nRegistration details:\n{{attendee_summary}}\n\n{{payment_instructions}}'
        WHEN 'REGISTRATION_CONFIRMATION_UNPAID' THEN E'Hello {{recipient_name}},\n\nWe received your registration for {{event_name}}.\n\nConfirmation: {{confirmation_code}}\nEvent: {{event_dates}}\nLocation: {{event_location}}\nTotal: {{total_amount}}\nBalance due: {{balance_amount}}\n\nRegistration details:\n{{attendee_summary}}\n\n{{payment_instructions}}'
        WHEN 'WORKER_CONFIRMATION' THEN E'Hello {{recipient_name}},\n\nThank you for serving at {{event_name}}.\n\nConfirmation: {{confirmation_code}}\nEvent: {{event_dates}}\nLocation: {{event_location}}\n\nWorker registration details:\n{{attendee_summary}}\n\nThe event team will follow up with any assignment details.'
        ELSE E'A new registration was received for {{event_name}}.\n\nRegistrant: {{registrant_name}}\nConfirmation: {{confirmation_code}}\nTotal: {{total_amount}}\nBalance due: {{balance_amount}}\n\nRegistration details:\n{{attendee_summary}}'
    END,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "EventMessageTemplate" template;
