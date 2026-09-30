-- "Group" registrations on club events (#650): people who are not in a club,
-- registered by one contact who is billed after the event.
--
-- A group registration is an ordinary Registration with a GroupEventRegistration
-- marker, deliberately not a ClubEventRegistration, so it is never attributable
-- to a club or church. Class seats a group holds have no club, so
-- HonorEnrollment.organizationId becomes optional (existing rows keep theirs).

CREATE TABLE "GroupEventRegistration" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "billingPersonId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupEventRegistration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GroupEventRegistration_registrationId_key" ON "GroupEventRegistration"("registrationId");

CREATE INDEX "GroupEventRegistration_eventId_idx" ON "GroupEventRegistration"("eventId");

CREATE INDEX "GroupEventRegistration_billingPersonId_idx" ON "GroupEventRegistration"("billingPersonId");

ALTER TABLE "GroupEventRegistration" ADD CONSTRAINT "GroupEventRegistration_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GroupEventRegistration" ADD CONSTRAINT "GroupEventRegistration_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GroupEventRegistration" ADD CONSTRAINT "GroupEventRegistration_billingPersonId_fkey" FOREIGN KEY ("billingPersonId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "HonorEnrollment" ALTER COLUMN "organizationId" DROP NOT NULL;

-- The contact of a group registration amends it through the private manage
-- link, with no staff user or attendee account: record the person instead.
-- Exactly one actor column is set for every row, old and new.
ALTER TABLE "RegistrationOperation" ADD COLUMN "actorPersonId" TEXT;

ALTER TABLE "RegistrationOperation" DROP CONSTRAINT "RegistrationOperation_actor_check";

ALTER TABLE "RegistrationOperation" ADD CONSTRAINT "RegistrationOperation_actor_check" CHECK (
  (("actorUserId" IS NOT NULL)::int + ("actorAttendeeAccountId" IS NOT NULL)::int + ("actorPersonId" IS NOT NULL)::int) = 1
);

CREATE INDEX "RegistrationOperation_actorPersonId_createdAt_idx" ON "RegistrationOperation"("actorPersonId", "createdAt");

ALTER TABLE "RegistrationOperation" ADD CONSTRAINT "RegistrationOperation_actorPersonId_fkey" FOREIGN KEY ("actorPersonId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
