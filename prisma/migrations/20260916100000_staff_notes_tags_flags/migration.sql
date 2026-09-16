CREATE TYPE "NoteVisibility" AS ENUM ('STAFF', 'RESTRICTED');

CREATE TABLE "EventTag" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EventTag_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RegistrationTagAssignment" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "appliedByUserId" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedByUserId" TEXT,
    "removedAt" TIMESTAMP(3),
    CONSTRAINT "RegistrationTagAssignment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AttendeeTagAssignment" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "attendeeId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "appliedByUserId" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedByUserId" TEXT,
    "removedAt" TIMESTAMP(3),
    CONSTRAINT "AttendeeTagAssignment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StaffNote" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "registrationId" TEXT,
    "attendeeId" TEXT,
    "personId" TEXT,
    "visibility" "NoteVisibility" NOT NULL DEFAULT 'STAFF',
    "restrictedPermission" TEXT,
    "authorUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StaffNote_pkey" PRIMARY KEY ("id"),
    -- Exactly one subject: a note belongs to a registration, an attendee, or
    -- a person, never zero and never more than one.
    CONSTRAINT "StaffNote_single_subject_check" CHECK (
      (CASE WHEN "registrationId" IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN "attendeeId" IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN "personId" IS NOT NULL THEN 1 ELSE 0 END) = 1
    ),
    -- restrictedPermission is required exactly when visibility is RESTRICTED.
    CONSTRAINT "StaffNote_restricted_permission_check" CHECK (
      ("visibility" = 'RESTRICTED' AND "restrictedPermission" IS NOT NULL)
      OR ("visibility" = 'STAFF' AND "restrictedPermission" IS NULL)
    )
);

CREATE TABLE "StaffNoteRevision" (
    "id" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StaffNoteRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EventTag_eventId_normalizedName_key" ON "EventTag"("eventId", "normalizedName");
CREATE INDEX "EventTag_eventId_isActive_name_idx" ON "EventTag"("eventId", "isActive", "name");

CREATE INDEX "RegistrationTagAssignment_eventId_registrationId_removedAt_idx" ON "RegistrationTagAssignment"("eventId", "registrationId", "removedAt");
CREATE INDEX "RegistrationTagAssignment_tagId_removedAt_idx" ON "RegistrationTagAssignment"("tagId", "removedAt");

CREATE INDEX "AttendeeTagAssignment_eventId_attendeeId_removedAt_idx" ON "AttendeeTagAssignment"("eventId", "attendeeId", "removedAt");
CREATE INDEX "AttendeeTagAssignment_tagId_removedAt_idx" ON "AttendeeTagAssignment"("tagId", "removedAt");

CREATE INDEX "StaffNote_eventId_registrationId_idx" ON "StaffNote"("eventId", "registrationId");
CREATE INDEX "StaffNote_eventId_attendeeId_idx" ON "StaffNote"("eventId", "attendeeId");
CREATE INDEX "StaffNote_eventId_personId_idx" ON "StaffNote"("eventId", "personId");

CREATE UNIQUE INDEX "StaffNoteRevision_noteId_sequence_key" ON "StaffNoteRevision"("noteId", "sequence");
CREATE INDEX "StaffNoteRevision_noteId_createdAt_idx" ON "StaffNoteRevision"("noteId", "createdAt");

ALTER TABLE "EventTag" ADD CONSTRAINT "EventTag_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RegistrationTagAssignment" ADD CONSTRAINT "RegistrationTagAssignment_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RegistrationTagAssignment" ADD CONSTRAINT "RegistrationTagAssignment_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RegistrationTagAssignment" ADD CONSTRAINT "RegistrationTagAssignment_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "EventTag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RegistrationTagAssignment" ADD CONSTRAINT "RegistrationTagAssignment_appliedByUserId_fkey" FOREIGN KEY ("appliedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RegistrationTagAssignment" ADD CONSTRAINT "RegistrationTagAssignment_removedByUserId_fkey" FOREIGN KEY ("removedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AttendeeTagAssignment" ADD CONSTRAINT "AttendeeTagAssignment_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttendeeTagAssignment" ADD CONSTRAINT "AttendeeTagAssignment_attendeeId_fkey" FOREIGN KEY ("attendeeId") REFERENCES "RegistrationAttendee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttendeeTagAssignment" ADD CONSTRAINT "AttendeeTagAssignment_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "EventTag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AttendeeTagAssignment" ADD CONSTRAINT "AttendeeTagAssignment_appliedByUserId_fkey" FOREIGN KEY ("appliedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AttendeeTagAssignment" ADD CONSTRAINT "AttendeeTagAssignment_removedByUserId_fkey" FOREIGN KEY ("removedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StaffNote" ADD CONSTRAINT "StaffNote_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StaffNote" ADD CONSTRAINT "StaffNote_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StaffNote" ADD CONSTRAINT "StaffNote_attendeeId_fkey" FOREIGN KEY ("attendeeId") REFERENCES "RegistrationAttendee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StaffNote" ADD CONSTRAINT "StaffNote_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StaffNote" ADD CONSTRAINT "StaffNote_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StaffNoteRevision" ADD CONSTRAINT "StaffNoteRevision_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "StaffNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StaffNoteRevision" ADD CONSTRAINT "StaffNoteRevision_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Cross-event references are rejected even when an ID exists, mirroring the
-- attendee-type configuration guard: a tag, registration, or attendee that
-- belongs to another event can never be linked into this event's rows.
CREATE OR REPLACE FUNCTION enforce_registration_tag_assignment_event() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Registration" r WHERE r."id" = NEW."registrationId" AND r."eventId" = NEW."eventId"
  ) THEN
    RAISE EXCEPTION 'registration belongs to another event';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "EventTag" t WHERE t."id" = NEW."tagId" AND t."eventId" = NEW."eventId"
  ) THEN
    RAISE EXCEPTION 'tag belongs to another event';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RegistrationTagAssignment_event_guard"
BEFORE INSERT OR UPDATE OF "eventId", "registrationId", "tagId" ON "RegistrationTagAssignment"
FOR EACH ROW EXECUTE FUNCTION enforce_registration_tag_assignment_event();

CREATE OR REPLACE FUNCTION enforce_attendee_tag_assignment_event() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "RegistrationAttendee" a WHERE a."id" = NEW."attendeeId" AND a."eventId" = NEW."eventId"
  ) THEN
    RAISE EXCEPTION 'attendee belongs to another event';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "EventTag" t WHERE t."id" = NEW."tagId" AND t."eventId" = NEW."eventId"
  ) THEN
    RAISE EXCEPTION 'tag belongs to another event';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AttendeeTagAssignment_event_guard"
BEFORE INSERT OR UPDATE OF "eventId", "attendeeId", "tagId" ON "AttendeeTagAssignment"
FOR EACH ROW EXECUTE FUNCTION enforce_attendee_tag_assignment_event();

CREATE OR REPLACE FUNCTION enforce_staff_note_subject_event() RETURNS trigger AS $$
BEGIN
  IF NEW."registrationId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Registration" r WHERE r."id" = NEW."registrationId" AND r."eventId" = NEW."eventId"
  ) THEN
    RAISE EXCEPTION 'registration belongs to another event';
  END IF;
  IF NEW."attendeeId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "RegistrationAttendee" a WHERE a."id" = NEW."attendeeId" AND a."eventId" = NEW."eventId"
  ) THEN
    RAISE EXCEPTION 'attendee belongs to another event';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "StaffNote_subject_event_guard"
BEFORE INSERT OR UPDATE OF "eventId", "registrationId", "attendeeId" ON "StaffNote"
FOR EACH ROW EXECUTE FUNCTION enforce_staff_note_subject_event();
