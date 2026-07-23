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
        ('WAITLIST_JOINED'),
        ('WAITLIST_PROMOTED'),
        ('REGISTRATION_CANCELLED'),
        ('REGISTRATION_CONTACT_UPDATED'),
        ('PAYMENT_RECEIPT')
) AS template("key")
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
    CASE template."key"
        WHEN 'WAITLIST_JOINED' THEN 'Waitlist confirmation: {{event_name}} ({{confirmation_code}})'
        WHEN 'WAITLIST_PROMOTED' THEN 'A place is available: {{event_name}}'
        WHEN 'REGISTRATION_CANCELLED' THEN 'Registration cancelled: {{event_name}}'
        WHEN 'REGISTRATION_CONTACT_UPDATED' THEN 'Contact details updated: {{event_name}}'
        ELSE 'Payment received: {{event_name}} ({{confirmation_code}})'
    END,
    CASE template."key"
        WHEN 'WAITLIST_JOINED' THEN E'Hello {{recipient_name}},\n\nYour registration is on the waitlist for {{event_name}}.\n\nConfirmation code: {{confirmation_code}}\nWaitlist position: {{waitlist_position}}\nDates: {{event_dates}}\nLocation: {{event_location}}\n\nNo payment is due while you are on the waitlist. Please do not submit payment unless we confirm that a place is available.\n\nReview your registration:\n{{portal_url}}\n\nQuestions? Contact {{reply_to_email}}.'
        WHEN 'WAITLIST_PROMOTED' THEN E'Hello {{recipient_name}},\n\nA place is now available for your registration for {{event_name}}.\n\nConfirmation code: {{confirmation_code}}\nBalance due: {{balance_amount}}\n\nNext payment step:\n{{payment_instructions}}\n\nReview your registration or continue payment:\n{{portal_url}}\n\nQuestions? Contact {{reply_to_email}}.'
        WHEN 'REGISTRATION_CANCELLED' THEN E'Hello {{recipient_name}},\n\nYour registration for {{event_name}} has been cancelled.\n\nConfirmation code: {{confirmation_code}}\n\nPayment and refund information:\n{{payment_instructions}}\n\nYour registration total and payment/refund history remain on record.\n\nReview the cancelled registration:\n{{portal_url}}\n\nQuestions? Contact {{reply_to_email}}.'
        WHEN 'REGISTRATION_CONTACT_UPDATED' THEN E'Hello {{recipient_name}},\n\nThe contact details for registration {{confirmation_code}} at {{event_name}} were updated.\n\nFuture registration messages will be sent to {{contact_email}}.\n\nReview your registration:\n{{portal_url}}\n\nIf you did not make this change, contact {{reply_to_email}}.'
        ELSE E'Hello {{recipient_name}},\n\nWe received your payment for {{event_name}}.\n\nConfirmation code: {{confirmation_code}}\nPayment received: {{payment_amount}}\nPayment reference: {{payment_reference}}\nRegistration total: {{total_amount}}\nBalance due: {{balance_amount}}\n\nReview your registration and payment history:\n{{portal_url}}\n\nQuestions? Contact {{reply_to_email}}.'
    END,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "EventMessageTemplate" template
WHERE template."key" IN (
    'WAITLIST_JOINED',
    'WAITLIST_PROMOTED',
    'REGISTRATION_CANCELLED',
    'REGISTRATION_CONTACT_UPDATED',
    'PAYMENT_RECEIPT'
)
ON CONFLICT ("templateId", "versionNumber") DO NOTHING;
