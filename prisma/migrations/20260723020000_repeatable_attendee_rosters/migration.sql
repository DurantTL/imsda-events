-- Preserve existing one-person submissions while adding ordered attendee answer
-- snapshots and a per-participant capacity key for household/group registrations.
ALTER TABLE "RegistrationAttendee"
  ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "formResponses" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "PublicRegistrationSubmission"
  ADD COLUMN "attendeeResponses" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "RegistrationCapacityReservation"
  ADD COLUMN "registrationAttendeeId" TEXT,
  ADD COLUMN "participantKey" TEXT NOT NULL DEFAULT 'registration';

DROP INDEX "RegistrationCapacityReservation_registrationId_fieldId_optionValue_key";

CREATE UNIQUE INDEX "RegistrationCapacityReservation_scoped_choice_key"
  ON "RegistrationCapacityReservation"("registrationId", "participantKey", "fieldId", "optionValue");

CREATE INDEX "RegistrationAttendee_registrationId_position_idx"
  ON "RegistrationAttendee"("registrationId", "position");

CREATE INDEX "RegistrationCapacityReservation_registrationAttendeeId_idx"
  ON "RegistrationCapacityReservation"("registrationAttendeeId");

ALTER TABLE "RegistrationCapacityReservation"
  ADD CONSTRAINT "RegistrationCapacityReservation_registrationAttendeeId_fkey"
  FOREIGN KEY ("registrationAttendeeId") REFERENCES "RegistrationAttendee"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
