CREATE TABLE "PublicRegistrationSubmission" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "formVersionId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responses" JSONB NOT NULL,
    "pricingSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PublicRegistrationSubmission_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RegistrationCapacityReservation" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "formVersionId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "optionValue" TEXT NOT NULL,
    "rank" INTEGER,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RegistrationCapacityReservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PublicRegistrationSubmission_registrationId_key" ON "PublicRegistrationSubmission"("registrationId");
CREATE UNIQUE INDEX "PublicRegistrationSubmission_formVersionId_idempotencyKey_key" ON "PublicRegistrationSubmission"("formVersionId", "idempotencyKey");
CREATE INDEX "PublicRegistrationSubmission_eventId_createdAt_idx" ON "PublicRegistrationSubmission"("eventId", "createdAt");
CREATE INDEX "PublicRegistrationSubmission_formVersionId_createdAt_idx" ON "PublicRegistrationSubmission"("formVersionId", "createdAt");

CREATE UNIQUE INDEX "RegistrationCapacityReservation_registrationId_fieldId_optionValue_key" ON "RegistrationCapacityReservation"("registrationId", "fieldId", "optionValue");
CREATE INDEX "RegistrationCapacityReservation_formId_fieldId_optionValue_releasedAt_idx" ON "RegistrationCapacityReservation"("formId", "fieldId", "optionValue", "releasedAt");
CREATE INDEX "RegistrationCapacityReservation_eventId_createdAt_idx" ON "RegistrationCapacityReservation"("eventId", "createdAt");

CREATE UNIQUE INDEX "RegistrationFormVersion_one_published_per_form" ON "RegistrationFormVersion"("formId") WHERE "status" = 'PUBLISHED';
CREATE UNIQUE INDEX "RegistrationFormVersion_one_draft_per_form" ON "RegistrationFormVersion"("formId") WHERE "status" = 'DRAFT';

ALTER TABLE "PublicRegistrationSubmission" ADD CONSTRAINT "PublicRegistrationSubmission_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublicRegistrationSubmission" ADD CONSTRAINT "PublicRegistrationSubmission_formVersionId_fkey" FOREIGN KEY ("formVersionId") REFERENCES "RegistrationFormVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PublicRegistrationSubmission" ADD CONSTRAINT "PublicRegistrationSubmission_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RegistrationCapacityReservation" ADD CONSTRAINT "RegistrationCapacityReservation_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RegistrationCapacityReservation" ADD CONSTRAINT "RegistrationCapacityReservation_formId_fkey" FOREIGN KEY ("formId") REFERENCES "RegistrationForm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RegistrationCapacityReservation" ADD CONSTRAINT "RegistrationCapacityReservation_formVersionId_fkey" FOREIGN KEY ("formVersionId") REFERENCES "RegistrationFormVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RegistrationCapacityReservation" ADD CONSTRAINT "RegistrationCapacityReservation_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
