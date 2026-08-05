ALTER TABLE "Event"
ADD COLUMN "seminarPreferenceClosesOn" TEXT,
ADD COLUMN "seminarPreferenceSelfServiceLocked" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "AuditLog_seminar_preference_request_key"
ON "AuditLog"("action", "eventId", "entityId", "correlationId")
WHERE "action" IN (
  'ATTENDEE_ACCOUNT_ANSWERS_UPDATED',
  'PRIVATE_LINK_ANSWERS_UPDATED'
);
