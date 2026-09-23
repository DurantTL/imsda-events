-- CreateTable
CREATE TABLE "ClubEventRegistration" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "submittedByAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubEventRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubRegistrationDraft" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "selectedMemberIds" TEXT[],
    "responses" JSONB NOT NULL DEFAULT '{}',
    "attendeeResponses" JSONB NOT NULL DEFAULT '{}',
    "updatedByAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubRegistrationDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClubEventRegistration_registrationId_key" ON "ClubEventRegistration"("registrationId");

-- CreateIndex
CREATE INDEX "ClubEventRegistration_organizationId_idx" ON "ClubEventRegistration"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ClubEventRegistration_eventId_organizationId_key" ON "ClubEventRegistration"("eventId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ClubRegistrationDraft_eventId_organizationId_key" ON "ClubRegistrationDraft"("eventId", "organizationId");

-- AddForeignKey
ALTER TABLE "ClubEventRegistration" ADD CONSTRAINT "ClubEventRegistration_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubEventRegistration" ADD CONSTRAINT "ClubEventRegistration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubEventRegistration" ADD CONSTRAINT "ClubEventRegistration_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubEventRegistration" ADD CONSTRAINT "ClubEventRegistration_submittedByAccountId_fkey" FOREIGN KEY ("submittedByAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubRegistrationDraft" ADD CONSTRAINT "ClubRegistrationDraft_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubRegistrationDraft" ADD CONSTRAINT "ClubRegistrationDraft_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubRegistrationDraft" ADD CONSTRAINT "ClubRegistrationDraft_updatedByAccountId_fkey" FOREIGN KEY ("updatedByAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

