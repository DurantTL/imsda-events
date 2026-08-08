CREATE TABLE "EventPaymentInstructionVersion" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "versionNumber" INTEGER NOT NULL,
  "instructions" TEXT,
  "approvedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EventPaymentInstructionVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EventPaymentInstructionVersion_eventId_versionNumber_key"
  ON "EventPaymentInstructionVersion"("eventId", "versionNumber");
CREATE INDEX "EventPaymentInstructionVersion_eventId_createdAt_idx"
  ON "EventPaymentInstructionVersion"("eventId", "createdAt");
ALTER TABLE "EventPaymentInstructionVersion"
  ADD CONSTRAINT "EventPaymentInstructionVersion_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventPaymentInstructionVersion"
  ADD CONSTRAINT "EventPaymentInstructionVersion_approvedByUserId_fkey"
  FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
