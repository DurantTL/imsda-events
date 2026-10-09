-- Honors Weekend class instructors (#833). Additive: three new tables, nothing
-- existing is changed. Staff invite an instructor to chosen classes; the
-- invited person accepts from their own attendee account. Marks live in their
-- own table and feed the existing Honors Weekend write-back.

-- CreateTable
CREATE TABLE "HonorInstructor" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "attendeeAccountId" TEXT,
    "createdByUserId" TEXT,
    "sentAt" TIMESTAMP(3),
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HonorInstructor_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "HonorInstructorClass" (
    "id" TEXT NOT NULL,
    "instructorId" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HonorInstructorClass_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "HonorEnrollmentMark" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "attended" BOOLEAN NOT NULL,
    "completed" BOOLEAN NOT NULL,
    "markedByInstructorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HonorEnrollmentMark_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "HonorInstructor_attendeeAccountId_idx" ON "HonorInstructor"("attendeeAccountId");
-- CreateIndex
CREATE INDEX "HonorInstructor_email_idx" ON "HonorInstructor"("email");
-- CreateIndex
CREATE UNIQUE INDEX "HonorInstructor_eventId_email_key" ON "HonorInstructor"("eventId", "email");
-- CreateIndex
CREATE INDEX "HonorInstructorClass_offeringId_idx" ON "HonorInstructorClass"("offeringId");
-- CreateIndex
CREATE UNIQUE INDEX "HonorInstructorClass_instructorId_offeringId_key" ON "HonorInstructorClass"("instructorId", "offeringId");
-- CreateIndex
CREATE UNIQUE INDEX "HonorEnrollmentMark_enrollmentId_key" ON "HonorEnrollmentMark"("enrollmentId");
-- CreateIndex
CREATE INDEX "HonorEnrollmentMark_markedByInstructorId_idx" ON "HonorEnrollmentMark"("markedByInstructorId");
-- AddForeignKey
ALTER TABLE "HonorInstructor" ADD CONSTRAINT "HonorInstructor_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "HonorInstructor" ADD CONSTRAINT "HonorInstructor_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "HonorInstructor" ADD CONSTRAINT "HonorInstructor_attendeeAccountId_fkey" FOREIGN KEY ("attendeeAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "HonorInstructorClass" ADD CONSTRAINT "HonorInstructorClass_instructorId_fkey" FOREIGN KEY ("instructorId") REFERENCES "HonorInstructor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "HonorInstructorClass" ADD CONSTRAINT "HonorInstructorClass_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "HonorOffering"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "HonorEnrollmentMark" ADD CONSTRAINT "HonorEnrollmentMark_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "HonorEnrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "HonorEnrollmentMark" ADD CONSTRAINT "HonorEnrollmentMark_markedByInstructorId_fkey" FOREIGN KEY ("markedByInstructorId") REFERENCES "HonorInstructor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- An instructor's email is stored lower-cased and is never empty.
ALTER TABLE "HonorInstructor" ADD CONSTRAINT "HonorInstructor_email_check" CHECK ("email" <> '' AND "email" = lower("email"));

-- Completed always includes attended.
ALTER TABLE "HonorEnrollmentMark" ADD CONSTRAINT "HonorEnrollmentMark_completed_attended_check" CHECK ("attended" OR NOT "completed");
