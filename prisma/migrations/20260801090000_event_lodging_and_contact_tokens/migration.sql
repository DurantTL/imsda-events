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

-- {{contact_email}} now resolves to the event organiser's published contact
-- address; the registration's own destination moved to
-- {{registration_contact_email}}. Every stored template version is rewritten to
-- the new token so an already-published template keeps rendering exactly the
-- value it rendered before this migration.
UPDATE "MessageTemplateVersion"
SET "bodyTemplate" = REPLACE(
      REPLACE("bodyTemplate", '{{contact_email}}', '{{registration_contact_email}}'),
      '{{ contact_email }}',
      '{{registration_contact_email}}'
    )
WHERE "bodyTemplate" LIKE '%contact_email%';

UPDATE "MessageTemplateVersion"
SET "subjectTemplate" = REPLACE(
      REPLACE("subjectTemplate", '{{contact_email}}', '{{registration_contact_email}}'),
      '{{ contact_email }}',
      '{{registration_contact_email}}'
    )
WHERE "subjectTemplate" LIKE '%contact_email%';
