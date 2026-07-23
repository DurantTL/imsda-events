CREATE TYPE "RegistrationOperationType" AS ENUM (
  'TRANSFER',
  'ATTENDEE_SUBSTITUTION'
);

ALTER TYPE "MessageTemplateKey"
  ADD VALUE 'REGISTRATION_TRANSFERRED_NEW_CONTACT';
ALTER TYPE "MessageTemplateKey"
  ADD VALUE 'REGISTRATION_TRANSFERRED_PRIOR_CONTACT';
ALTER TYPE "MessageTemplateKey"
  ADD VALUE 'ATTENDEE_SUBSTITUTED';

CREATE TABLE "RegistrationOperation" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "registrationId" TEXT NOT NULL,
  "attendeeId" TEXT,
  "type" "RegistrationOperationType" NOT NULL,
  "clientRequestId" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "actorNameSnapshot" TEXT NOT NULL,
  "beforeSnapshot" JSONB NOT NULL,
  "afterSnapshot" JSONB NOT NULL,
  "responseSnapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RegistrationOperation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RegistrationOperation_eventId_clientRequestId_key"
  ON "RegistrationOperation"("eventId", "clientRequestId");
CREATE INDEX "RegistrationOperation_registrationId_createdAt_idx"
  ON "RegistrationOperation"("registrationId", "createdAt");
CREATE INDEX "RegistrationOperation_attendeeId_createdAt_idx"
  ON "RegistrationOperation"("attendeeId", "createdAt");
CREATE INDEX "RegistrationOperation_actorUserId_createdAt_idx"
  ON "RegistrationOperation"("actorUserId", "createdAt");

ALTER TABLE "RegistrationOperation"
  ADD CONSTRAINT "RegistrationOperation_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RegistrationOperation"
  ADD CONSTRAINT "RegistrationOperation_registrationId_fkey"
  FOREIGN KEY ("registrationId") REFERENCES "Registration"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RegistrationOperation"
  ADD CONSTRAINT "RegistrationOperation_attendeeId_fkey"
  FOREIGN KEY ("attendeeId") REFERENCES "RegistrationAttendee"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RegistrationOperation"
  ADD CONSTRAINT "RegistrationOperation_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "reject_registration_operation_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'RegistrationOperation rows are immutable';
END;
$$;

CREATE TRIGGER "RegistrationOperation_immutable"
BEFORE UPDATE OR DELETE ON "RegistrationOperation"
FOR EACH ROW
EXECUTE FUNCTION "reject_registration_operation_mutation"();
