-- Per-event lodging. Rendered into messages through {{hotel_information}} and
-- omitted entirely when "hotelName" is null, so an event with no room block
-- never carries another event's hotel.
ALTER TABLE "Event"
ADD COLUMN "hotelName" TEXT,
ADD COLUMN "hotelBookingUrl" TEXT,
ADD COLUMN "hotelPhone" TEXT,
ADD COLUMN "hotelGroupName" TEXT,
ADD COLUMN "hotelRate" TEXT,
ADD COLUMN "hotelInstructions" TEXT;

-- The formatted body, rendered from the same template and context as the text
-- snapshot at enqueue time. Nullable because rows queued before this migration
-- have no HTML part; delivery sends those as text only rather than deriving
-- HTML from a body whose untrusted spans it can no longer identify.
ALTER TABLE "MessageOutbox"
ADD COLUMN "bodyHtmlSnapshot" TEXT;

-- {{contact_email}} now resolves to the event organiser's published contact
-- address; the registration's own destination moved to
-- {{registration_contact_email}}. Every stored template version is rewritten to
-- the new token so an already-published template keeps rendering exactly the
-- value it rendered before this migration.
--
-- The renderer trims arbitrary whitespace inside the braces, so `{{ contact_email}}`
-- and `{{contact_email  }}` are equally valid spellings that staff may have
-- saved. A regular expression covers all of them; a pair of literal REPLACE
-- calls would migrate two spellings and silently change the meaning of the rest.
UPDATE "MessageTemplateVersion"
SET "bodyTemplate" = regexp_replace(
      "bodyTemplate",
      '\{\{\s*contact_email\s*\}\}',
      '{{registration_contact_email}}',
      'g'
    )
WHERE "bodyTemplate" ~ '\{\{\s*contact_email\s*\}\}';

UPDATE "MessageTemplateVersion"
SET "subjectTemplate" = regexp_replace(
      "subjectTemplate",
      '\{\{\s*contact_email\s*\}\}',
      '{{registration_contact_email}}',
      'g'
    )
WHERE "subjectTemplate" ~ '\{\{\s*contact_email\s*\}\}';
