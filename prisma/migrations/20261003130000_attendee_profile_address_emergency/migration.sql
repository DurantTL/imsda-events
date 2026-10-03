-- Optional mailing address and emergency contact on the attendee profile (#742).
-- Additive and nullable: existing accounts are unchanged.
ALTER TABLE "AttendeeAccount"
  ADD COLUMN "mailingLine1" TEXT,
  ADD COLUMN "mailingLine2" TEXT,
  ADD COLUMN "mailingCity" TEXT,
  ADD COLUMN "mailingRegion" TEXT,
  ADD COLUMN "mailingPostalCode" TEXT,
  ADD COLUMN "mailingCountry" TEXT,
  ADD COLUMN "emergencyContactName" TEXT,
  ADD COLUMN "emergencyContactRelationship" TEXT,
  ADD COLUMN "emergencyContactPhone" TEXT;
