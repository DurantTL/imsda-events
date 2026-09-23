-- CreateTable
CREATE TABLE "HonorEnrollment" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "registrationAttendeeId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "consumesSeat" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HonorEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HonorEnrollment_offeringId_consumesSeat_idx" ON "HonorEnrollment"("offeringId", "consumesSeat");

-- CreateIndex
CREATE INDEX "HonorEnrollment_offeringId_organizationId_consumesSeat_idx" ON "HonorEnrollment"("offeringId", "organizationId", "consumesSeat");

-- CreateIndex
CREATE INDEX "HonorEnrollment_registrationId_idx" ON "HonorEnrollment"("registrationId");

-- CreateIndex
CREATE UNIQUE INDEX "HonorEnrollment_registrationAttendeeId_offeringId_key" ON "HonorEnrollment"("registrationAttendeeId", "offeringId");

-- AddForeignKey
ALTER TABLE "HonorEnrollment" ADD CONSTRAINT "HonorEnrollment_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HonorEnrollment" ADD CONSTRAINT "HonorEnrollment_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "HonorOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HonorEnrollment" ADD CONSTRAINT "HonorEnrollment_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HonorEnrollment" ADD CONSTRAINT "HonorEnrollment_registrationAttendeeId_fkey" FOREIGN KEY ("registrationAttendeeId") REFERENCES "RegistrationAttendee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HonorEnrollment" ADD CONSTRAINT "HonorEnrollment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

