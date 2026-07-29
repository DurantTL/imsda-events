-- The cost of an attendee edit is event policy, not a code constant.
CREATE TYPE "AttendeeEditPolicy" AS ENUM ('TIERED', 'VERIFY_EVERY_EDIT');

ALTER TABLE "PlatformSettings"
ADD COLUMN "defaultAttendeeEditPolicy" "AttendeeEditPolicy"
NOT NULL DEFAULT 'VERIFY_EVERY_EDIT';

ALTER TABLE "Event"
ADD COLUMN "attendeeEditPolicy" "AttendeeEditPolicy"
NOT NULL DEFAULT 'VERIFY_EVERY_EDIT';

-- The accepted ADR explicitly keeps the current Women's Retreat lenient while
-- later events inherit the strict platform default.
UPDATE "Event"
SET "attendeeEditPolicy" = 'TIERED'
WHERE "slug" = 'womens-retreat-2026';
