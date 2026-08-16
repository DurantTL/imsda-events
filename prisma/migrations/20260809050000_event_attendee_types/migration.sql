CREATE TYPE "AttendeeClassificationKind" AS ENUM ('CATEGORY', 'TRACK', 'DEPARTMENT');

CREATE TABLE "EventAttendeeType" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "minimumAge" INTEGER,
    "maximumAge" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EventAttendeeType_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EventAttendeeType_age_band_check" CHECK (
      ("minimumAge" IS NULL OR "minimumAge" >= 0)
      AND ("maximumAge" IS NULL OR "maximumAge" >= 0)
      AND ("minimumAge" IS NULL OR "maximumAge" IS NULL OR "minimumAge" <= "maximumAge")
    )
);

CREATE TABLE "EventAttendeeClassification" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "kind" "AttendeeClassificationKind" NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EventAttendeeClassification_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "RegistrationAttendee" ADD COLUMN "attendeeTypeDefinitionId" TEXT;

CREATE TABLE "RegistrationAttendeeClassification" (
    "attendeeId" TEXT NOT NULL,
    "classificationId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RegistrationAttendeeClassification_pkey" PRIMARY KEY ("attendeeId", "classificationId")
);

CREATE UNIQUE INDEX "EventAttendeeType_eventId_code_key" ON "EventAttendeeType"("eventId", "code");
CREATE INDEX "EventAttendeeType_eventId_isActive_sortOrder_label_idx" ON "EventAttendeeType"("eventId", "isActive", "sortOrder", "label");
CREATE UNIQUE INDEX "EventAttendeeClassification_eventId_kind_code_key" ON "EventAttendeeClassification"("eventId", "kind", "code");
CREATE INDEX "EventAttendeeClassification_eventId_kind_isActive_sortOrder_label_idx" ON "EventAttendeeClassification"("eventId", "kind", "isActive", "sortOrder", "label");
CREATE INDEX "RegistrationAttendee_attendeeTypeDefinitionId_idx" ON "RegistrationAttendee"("attendeeTypeDefinitionId");
CREATE INDEX "RegistrationAttendeeClassification_classificationId_idx" ON "RegistrationAttendeeClassification"("classificationId");

ALTER TABLE "EventAttendeeType" ADD CONSTRAINT "EventAttendeeType_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventAttendeeClassification" ADD CONSTRAINT "EventAttendeeClassification_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RegistrationAttendee" ADD CONSTRAINT "RegistrationAttendee_attendeeTypeDefinitionId_fkey" FOREIGN KEY ("attendeeTypeDefinitionId") REFERENCES "EventAttendeeType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RegistrationAttendeeClassification" ADD CONSTRAINT "RegistrationAttendeeClassification_attendeeId_fkey" FOREIGN KEY ("attendeeId") REFERENCES "RegistrationAttendee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RegistrationAttendeeClassification" ADD CONSTRAINT "RegistrationAttendeeClassification_classificationId_fkey" FOREIGN KEY ("classificationId") REFERENCES "EventAttendeeClassification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Cross-event references are rejected even when an ID exists. The nullable type
-- reference deliberately leaves legacy rows untouched for the explicit backfill.
CREATE OR REPLACE FUNCTION enforce_attendee_configuration_event() RETURNS trigger AS $$
BEGIN
  IF NEW."attendeeTypeDefinitionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "EventAttendeeType" t
    WHERE t."id" = NEW."attendeeTypeDefinitionId" AND t."eventId" = NEW."eventId"
  ) THEN
    RAISE EXCEPTION 'attendee type belongs to another event';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RegistrationAttendee_type_event_guard"
BEFORE INSERT OR UPDATE OF "eventId", "attendeeTypeDefinitionId" ON "RegistrationAttendee"
FOR EACH ROW EXECUTE FUNCTION enforce_attendee_configuration_event();

CREATE OR REPLACE FUNCTION enforce_attendee_classification_event() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "RegistrationAttendee" a
    JOIN "EventAttendeeClassification" c ON c."id" = NEW."classificationId"
    WHERE a."id" = NEW."attendeeId" AND a."eventId" = c."eventId"
  ) THEN
    RAISE EXCEPTION 'attendee classification belongs to another event';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RegistrationAttendeeClassification_event_guard"
BEFORE INSERT OR UPDATE ON "RegistrationAttendeeClassification"
FOR EACH ROW EXECUTE FUNCTION enforce_attendee_classification_event();
