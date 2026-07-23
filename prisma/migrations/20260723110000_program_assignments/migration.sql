CREATE TYPE "ProgramAssignmentOutcome" AS ENUM ('ASSIGNED', 'UNASSIGNED');

CREATE TYPE "ProgramUnassignedReason" AS ENUM ('NO_RANKED_CHOICES', 'CAPACITY_FULL');

CREATE TABLE "ProgramAssignmentRun" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "formVersionId" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "fieldKeySnapshot" TEXT NOT NULL,
    "fieldLabelSnapshot" TEXT NOT NULL,
    "formNameSnapshot" TEXT NOT NULL,
    "formVersionNumber" INTEGER NOT NULL,
    "optionsSnapshot" JSONB NOT NULL,
    "limitsSnapshot" JSONB NOT NULL,
    "summarySnapshot" JSONB NOT NULL,
    "sourceFingerprint" TEXT NOT NULL,
    "sourceParticipantCount" INTEGER NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "appliedByUserId" TEXT,
    "appliedByNameSnapshot" TEXT NOT NULL,
    "supersedesRunId" TEXT,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProgramAssignmentRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProgramAttendeeAssignment" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "attendeeIdSnapshot" TEXT NOT NULL,
    "registrationIdSnapshot" TEXT NOT NULL,
    "confirmationCodeSnapshot" TEXT NOT NULL,
    "registrationSubmittedAt" TIMESTAMP(3),
    "attendeePositionSnapshot" INTEGER NOT NULL,
    "stableOrder" INTEGER NOT NULL,
    "firstNameSnapshot" TEXT NOT NULL,
    "lastNameSnapshot" TEXT NOT NULL,
    "attendeeTypeSnapshot" TEXT NOT NULL,
    "preferencesSnapshot" JSONB NOT NULL,
    "optionValue" TEXT,
    "preferenceRank" INTEGER,
    "outcome" "ProgramAssignmentOutcome" NOT NULL,
    "unassignedReason" "ProgramUnassignedReason",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProgramAttendeeAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProgramAssignmentRun_eventId_clientRequestId_key"
ON "ProgramAssignmentRun"("eventId", "clientRequestId");

CREATE INDEX "ProgramAssignmentRun_eventId_formVersionId_fieldId_appliedAt_idx"
ON "ProgramAssignmentRun"("eventId", "formVersionId", "fieldId", "appliedAt");

CREATE INDEX "ProgramAssignmentRun_supersedesRunId_idx"
ON "ProgramAssignmentRun"("supersedesRunId");

CREATE UNIQUE INDEX "ProgramAttendeeAssignment_runId_attendeeIdSnapshot_key"
ON "ProgramAttendeeAssignment"("runId", "attendeeIdSnapshot");

CREATE INDEX "ProgramAttendeeAssignment_runId_optionValue_stableOrder_idx"
ON "ProgramAttendeeAssignment"("runId", "optionValue", "stableOrder");

CREATE INDEX "ProgramAttendeeAssignment_runId_outcome_stableOrder_idx"
ON "ProgramAttendeeAssignment"("runId", "outcome", "stableOrder");

ALTER TABLE "ProgramAssignmentRun"
ADD CONSTRAINT "ProgramAssignmentRun_eventId_fkey"
FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProgramAssignmentRun"
ADD CONSTRAINT "ProgramAssignmentRun_formId_fkey"
FOREIGN KEY ("formId") REFERENCES "RegistrationForm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProgramAssignmentRun"
ADD CONSTRAINT "ProgramAssignmentRun_formVersionId_fkey"
FOREIGN KEY ("formVersionId") REFERENCES "RegistrationFormVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProgramAssignmentRun"
ADD CONSTRAINT "ProgramAssignmentRun_appliedByUserId_fkey"
FOREIGN KEY ("appliedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ProgramAssignmentRun"
ADD CONSTRAINT "ProgramAssignmentRun_supersedesRunId_fkey"
FOREIGN KEY ("supersedesRunId") REFERENCES "ProgramAssignmentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ProgramAttendeeAssignment"
ADD CONSTRAINT "ProgramAttendeeAssignment_runId_fkey"
FOREIGN KEY ("runId") REFERENCES "ProgramAssignmentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
