-- PostgreSQL requires values added to an existing enum to be committed before
-- rows can safely use them, so template data is seeded separately.
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
    ('REGISTRATION_TRANSFERRED_NEW_CONTACT'),
    ('REGISTRATION_TRANSFERRED_PRIOR_CONTACT'),
    ('ATTENDEE_SUBSTITUTED')
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
    WHEN 'REGISTRATION_TRANSFERRED_NEW_CONTACT'
      THEN 'Registration transferred to you: {{event_name}} ({{confirmation_code}})'
    WHEN 'REGISTRATION_TRANSFERRED_PRIOR_CONTACT'
      THEN 'Registration contact transferred: {{event_name}} ({{confirmation_code}})'
    ELSE 'Attendee substitution recorded: {{event_name}} ({{confirmation_code}})'
  END,
  CASE template."key"
    WHEN 'REGISTRATION_TRANSFERRED_NEW_CONTACT'
      THEN E'Hello {{recipient_name}},\n\nStaff transferred registration {{confirmation_code}} for {{event_name}} to you.\n\nFuture registration messages will be sent to {{contact_email}}. The confirmation code, status, attendee party, submitted form and order snapshot, total, payments and refunds, promo redemption, capacity reservations, and waitlist position did not change.\n\nA new private link was created for this destination after the transfer committed. Prior private links no longer work.\n\nManage the registration:\n{{portal_url}}\n\nQuestions? Contact {{reply_to_email}}.'
    WHEN 'REGISTRATION_TRANSFERRED_PRIOR_CONTACT'
      THEN E'Hello {{recipient_name}},\n\nStaff transferred registration {{confirmation_code}} for {{event_name}} to {{new_person_name}}. You are no longer the registration contact, and prior private management links no longer work.\n\nThe confirmation code, status, attendee party, submitted form and order snapshot, total, payments and refunds, promo redemption, capacity reservations, and waitlist position did not change.\n\nIf this was unexpected, contact {{reply_to_email}}.'
    ELSE E'Hello {{recipient_name}},\n\nStaff updated registration {{confirmation_code}} for {{event_name}}: {{prior_person_name}} was replaced by {{new_person_name}}.\n\nThe attendee record, position, type, submitted choices, capacity reservations, and pricing did not change. The registration contact, status, total, payments and refunds, promo redemption, and waitlist position also remain unchanged.\n\nQuestions? Contact {{reply_to_email}}.'
  END,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "EventMessageTemplate" template
WHERE template."key" IN (
  'REGISTRATION_TRANSFERRED_NEW_CONTACT',
  'REGISTRATION_TRANSFERRED_PRIOR_CONTACT',
  'ATTENDEE_SUBSTITUTED'
)
ON CONFLICT ("templateId", "versionNumber") DO NOTHING;
