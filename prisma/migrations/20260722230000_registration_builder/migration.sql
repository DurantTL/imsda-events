ALTER TYPE "EventPermission" ADD VALUE 'MANAGE_FORMS';

CREATE TYPE "RegistrationFormStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

CREATE TABLE "RegistrationForm" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "RegistrationFormStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RegistrationForm_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RegistrationFormVersion" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "status" "RegistrationFormStatus" NOT NULL DEFAULT 'DRAFT',
    "definition" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RegistrationFormVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FormTestSubmission" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "formVersionId" TEXT NOT NULL,
    "submittedByUserId" TEXT NOT NULL,
    "responses" JSONB NOT NULL,
    "validation" JSONB NOT NULL,
    "isValid" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FormTestSubmission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RegistrationForm_eventId_slug_key" ON "RegistrationForm"("eventId", "slug");
CREATE INDEX "RegistrationForm_eventId_status_updatedAt_idx" ON "RegistrationForm"("eventId", "status", "updatedAt");
CREATE UNIQUE INDEX "RegistrationFormVersion_formId_versionNumber_key" ON "RegistrationFormVersion"("formId", "versionNumber");
CREATE INDEX "RegistrationFormVersion_formId_status_versionNumber_idx" ON "RegistrationFormVersion"("formId", "status", "versionNumber");
CREATE INDEX "FormTestSubmission_eventId_createdAt_idx" ON "FormTestSubmission"("eventId", "createdAt");
CREATE INDEX "FormTestSubmission_formVersionId_createdAt_idx" ON "FormTestSubmission"("formVersionId", "createdAt");

ALTER TABLE "RegistrationForm" ADD CONSTRAINT "RegistrationForm_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RegistrationForm" ADD CONSTRAINT "RegistrationForm_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RegistrationFormVersion" ADD CONSTRAINT "RegistrationFormVersion_formId_fkey" FOREIGN KEY ("formId") REFERENCES "RegistrationForm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RegistrationFormVersion" ADD CONSTRAINT "RegistrationFormVersion_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FormTestSubmission" ADD CONSTRAINT "FormTestSubmission_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FormTestSubmission" ADD CONSTRAINT "FormTestSubmission_formVersionId_fkey" FOREIGN KEY ("formVersionId") REFERENCES "RegistrationFormVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FormTestSubmission" ADD CONSTRAINT "FormTestSubmission_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
