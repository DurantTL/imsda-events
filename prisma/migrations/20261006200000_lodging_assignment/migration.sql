-- CreateEnum
CREATE TYPE "LodgingBucketKind" AS ENUM ('HOTEL', 'AIRBNB', 'HOME', 'OFFSITE', 'OTHER');

-- CreateEnum
CREATE TYPE "LodgingAssignmentSource" AS ENUM ('STAFF', 'PROPOSAL', 'CSV_IMPORT', 'WAITLIST');

-- CreateEnum
CREATE TYPE "LodgingAssignmentEventType" AS ENUM ('ASSIGNED', 'MOVED_IN', 'MOVED_OUT', 'SPLIT_REMAINDER', 'CANCELLED', 'TRANSFERRED_IN', 'TRANSFERRED_OUT', 'LATE_ARRIVAL', 'EARLY_DEPARTURE', 'LINKED');

-- CreateEnum
CREATE TYPE "LodgingWaitlistStatus" AS ENUM ('JOINED', 'OFFERED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'REMOVED', 'PROMOTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MessageTemplateKey" ADD VALUE 'LODGING_WAITLIST_OFFER';
ALTER TYPE "MessageTemplateKey" ADD VALUE 'LODGING_ASSIGNMENT_NOTICE';

-- AlterTable
ALTER TABLE "EventLodging" ADD COLUMN     "assignmentSettingsUpdatedByUserId" TEXT,
ADD COLUMN     "attendeeInstructions" TEXT,
ADD COLUMN     "showAssignmentsToAttendees" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "showRoommateFirstNames" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "EventLodgingBucket" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventLodgingId" TEXT NOT NULL,
    "kind" "LodgingBucketKind" NOT NULL,
    "label" TEXT NOT NULL,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventLodgingBucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventLodgingPlaceholder" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "headcount" INTEGER NOT NULL DEFAULT 1,
    "note" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "linkedAttendeeId" TEXT,
    "linkedAt" TIMESTAMP(3),
    "linkedByUserId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "archivedByUserId" TEXT,

    CONSTRAINT "EventLodgingPlaceholder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventLodgingAssignment" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventLodgingUnitId" TEXT,
    "bucketId" TEXT,
    "attendeeId" TEXT,
    "placeholderId" TEXT,
    "people" INTEGER NOT NULL DEFAULT 1,
    "firstNight" DATE NOT NULL,
    "lastNight" DATE NOT NULL,
    "source" "LodgingAssignmentSource" NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "reason" TEXT,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "cancelledByUserId" TEXT,
    "cancelReason" TEXT,

    CONSTRAINT "EventLodgingAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventLodgingAssignmentHistory" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "type" "LodgingAssignmentEventType" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" TEXT,
    "reason" TEXT,
    "source" "LodgingAssignmentSource",
    "attendeeId" TEXT,
    "placeholderId" TEXT,
    "people" INTEGER NOT NULL DEFAULT 1,
    "eventLodgingUnitId" TEXT,
    "bucketId" TEXT,
    "firstNight" DATE,
    "lastNight" DATE,
    "previousUnitId" TEXT,
    "previousBucketId" TEXT,
    "previousFirstNight" DATE,
    "previousLastNight" DATE,
    "preservedCapacity" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL,
    "relatedAssignmentId" TEXT,

    CONSTRAINT "EventLodgingAssignmentHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventLodgingAssignmentNotice" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "outboxMessageId" TEXT,
    "assignmentVersion" INTEGER NOT NULL,
    "sentByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventLodgingAssignmentNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventLodgingWaitlistEntry" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "category" "LodgingCategory" NOT NULL,
    "firstNight" DATE,
    "lastNight" DATE,
    "partySize" INTEGER NOT NULL,
    "status" "LodgingWaitlistStatus" NOT NULL DEFAULT 'JOINED',
    "offerNumber" INTEGER NOT NULL DEFAULT 0,
    "offeredAt" TIMESTAMP(3),
    "offerExpiresAt" TIMESTAMP(3),
    "offerMessageId" TEXT,
    "createdVia" "LodgingRequestSource" NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventLodgingWaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventLodgingWaitlistHistory" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "status" "LodgingWaitlistStatus" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" TEXT,
    "accessTokenId" TEXT,
    "reason" TEXT,
    "offerNumber" INTEGER NOT NULL DEFAULT 0,
    "offerExpiresAt" TIMESTAMP(3),
    "messageId" TEXT,

    CONSTRAINT "EventLodgingWaitlistHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventLodgingBucket_eventLodgingId_kind_key" ON "EventLodgingBucket"("eventLodgingId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "EventLodgingBucket_id_eventId_key" ON "EventLodgingBucket"("id", "eventId");

-- CreateIndex
CREATE INDEX "EventLodgingPlaceholder_eventId_idx" ON "EventLodgingPlaceholder"("eventId");

-- CreateIndex
CREATE INDEX "EventLodgingPlaceholder_linkedAttendeeId_idx" ON "EventLodgingPlaceholder"("linkedAttendeeId");

-- CreateIndex
CREATE UNIQUE INDEX "EventLodgingPlaceholder_id_eventId_key" ON "EventLodgingPlaceholder"("id", "eventId");

-- CreateIndex
CREATE INDEX "EventLodgingAssignment_eventId_eventLodgingUnitId_idx" ON "EventLodgingAssignment"("eventId", "eventLodgingUnitId");

-- CreateIndex
CREATE INDEX "EventLodgingAssignment_eventId_bucketId_idx" ON "EventLodgingAssignment"("eventId", "bucketId");

-- CreateIndex
CREATE INDEX "EventLodgingAssignment_attendeeId_idx" ON "EventLodgingAssignment"("attendeeId");

-- CreateIndex
CREATE INDEX "EventLodgingAssignment_placeholderId_idx" ON "EventLodgingAssignment"("placeholderId");

-- CreateIndex
CREATE UNIQUE INDEX "EventLodgingAssignment_id_eventId_key" ON "EventLodgingAssignment"("id", "eventId");

-- CreateIndex
CREATE INDEX "EventLodgingAssignmentHistory_eventId_at_idx" ON "EventLodgingAssignmentHistory"("eventId", "at");

-- CreateIndex
CREATE INDEX "EventLodgingAssignmentHistory_assignmentId_at_idx" ON "EventLodgingAssignmentHistory"("assignmentId", "at");

-- CreateIndex
CREATE INDEX "EventLodgingAssignmentHistory_attendeeId_idx" ON "EventLodgingAssignmentHistory"("attendeeId");

-- CreateIndex
CREATE INDEX "EventLodgingAssignmentNotice_eventId_registrationId_idx" ON "EventLodgingAssignmentNotice"("eventId", "registrationId");

-- CreateIndex
CREATE INDEX "EventLodgingWaitlistEntry_eventId_status_joinedAt_idx" ON "EventLodgingWaitlistEntry"("eventId", "status", "joinedAt");

-- CreateIndex
CREATE INDEX "EventLodgingWaitlistEntry_registrationId_idx" ON "EventLodgingWaitlistEntry"("registrationId");

-- CreateIndex
CREATE UNIQUE INDEX "EventLodgingWaitlistEntry_id_eventId_key" ON "EventLodgingWaitlistEntry"("id", "eventId");

-- CreateIndex
CREATE INDEX "EventLodgingWaitlistHistory_entryId_at_idx" ON "EventLodgingWaitlistHistory"("entryId", "at");

-- AddForeignKey
ALTER TABLE "EventLodgingBucket" ADD CONSTRAINT "EventLodgingBucket_eventLodgingId_eventId_fkey" FOREIGN KEY ("eventLodgingId", "eventId") REFERENCES "EventLodging"("id", "eventId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingPlaceholder" ADD CONSTRAINT "EventLodgingPlaceholder_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingPlaceholder" ADD CONSTRAINT "EventLodgingPlaceholder_linkedAttendeeId_fkey" FOREIGN KEY ("linkedAttendeeId") REFERENCES "RegistrationAttendee"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingAssignment" ADD CONSTRAINT "EventLodgingAssignment_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingAssignment" ADD CONSTRAINT "EventLodgingAssignment_eventLodgingUnitId_eventId_fkey" FOREIGN KEY ("eventLodgingUnitId", "eventId") REFERENCES "EventLodgingUnit"("id", "eventId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingAssignment" ADD CONSTRAINT "EventLodgingAssignment_bucketId_eventId_fkey" FOREIGN KEY ("bucketId", "eventId") REFERENCES "EventLodgingBucket"("id", "eventId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingAssignment" ADD CONSTRAINT "EventLodgingAssignment_attendeeId_fkey" FOREIGN KEY ("attendeeId") REFERENCES "RegistrationAttendee"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingAssignment" ADD CONSTRAINT "EventLodgingAssignment_placeholderId_eventId_fkey" FOREIGN KEY ("placeholderId", "eventId") REFERENCES "EventLodgingPlaceholder"("id", "eventId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingAssignmentHistory" ADD CONSTRAINT "EventLodgingAssignmentHistory_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingAssignmentHistory" ADD CONSTRAINT "EventLodgingAssignmentHistory_assignmentId_eventId_fkey" FOREIGN KEY ("assignmentId", "eventId") REFERENCES "EventLodgingAssignment"("id", "eventId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingAssignmentNotice" ADD CONSTRAINT "EventLodgingAssignmentNotice_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingAssignmentNotice" ADD CONSTRAINT "EventLodgingAssignmentNotice_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingWaitlistEntry" ADD CONSTRAINT "EventLodgingWaitlistEntry_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingWaitlistEntry" ADD CONSTRAINT "EventLodgingWaitlistEntry_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingWaitlistHistory" ADD CONSTRAINT "EventLodgingWaitlistHistory_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingWaitlistHistory" ADD CONSTRAINT "EventLodgingWaitlistHistory_entryId_eventId_fkey" FOREIGN KEY ("entryId", "eventId") REFERENCES "EventLodgingWaitlistEntry"("id", "eventId") ON DELETE CASCADE ON UPDATE CASCADE;



-- ---------------------------------------------------------------------------
-- Constraints and triggers Prisma cannot express (#200). Additive only.
-- The history tables are append-only and every table goes only with its event.
-- ---------------------------------------------------------------------------

-- Every event that already chose a property gets its five alternate-housing buckets (new properties get them from the app).
INSERT INTO "EventLodgingBucket" ("id", "eventId", "eventLodgingId", "kind", "label", "updatedAt")
SELECT 'lodgbkt_' || md5(el."id" || ':' || k.kind), el."eventId", el."id", k.kind::"LodgingBucketKind", k.label, CURRENT_TIMESTAMP
FROM "EventLodging" el
CROSS JOIN (VALUES ('HOTEL', 'Hotel'), ('AIRBNB', 'Airbnb'), ('HOME', 'Home'), ('OFFSITE', 'Offsite'), ('OTHER', 'Other')) AS k(kind, label);

ALTER TABLE "EventLodgingBucket" ADD CONSTRAINT "EventLodgingBucket_label_present" CHECK (length(btrim("label")) > 0);

-- Delete refusal shared by the assignment tables: rows go only with their event. That is the cascade once the event is
-- gone, or the event deletion service's own explicit deletes (it sets the transaction-local setting
-- `imsda.event_deletion`, as for the append-only registration ledgers, and must remove these rows before the
-- registrations they point at). Nothing else can delete one.
CREATE FUNCTION "EventLodgingAssignment_refuse_delete"() RETURNS trigger AS $$
BEGIN
  IF current_setting('imsda.event_deletion', true) = 'on'
     OR (pg_trigger_depth() > 1 AND NOT EXISTS (SELECT 1 FROM "Event" WHERE "id" = OLD."eventId")) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Lodging assignment records are never deleted while the event exists.' USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EventLodgingBucket_no_delete" BEFORE DELETE ON "EventLodgingBucket" FOR EACH ROW EXECUTE FUNCTION "EventLodgingAssignment_refuse_delete"();
CREATE TRIGGER "EventLodgingPlaceholder_no_delete" BEFORE DELETE ON "EventLodgingPlaceholder" FOR EACH ROW EXECUTE FUNCTION "EventLodgingAssignment_refuse_delete"();
CREATE TRIGGER "EventLodgingAssignment_no_delete" BEFORE DELETE ON "EventLodgingAssignment" FOR EACH ROW EXECUTE FUNCTION "EventLodgingAssignment_refuse_delete"();
CREATE TRIGGER "EventLodgingAssignmentHistory_no_delete" BEFORE DELETE ON "EventLodgingAssignmentHistory" FOR EACH ROW EXECUTE FUNCTION "EventLodgingAssignment_refuse_delete"();
CREATE TRIGGER "EventLodgingAssignmentNotice_no_delete" BEFORE DELETE ON "EventLodgingAssignmentNotice" FOR EACH ROW EXECUTE FUNCTION "EventLodgingAssignment_refuse_delete"();
CREATE TRIGGER "EventLodgingWaitlistEntry_no_delete" BEFORE DELETE ON "EventLodgingWaitlistEntry" FOR EACH ROW EXECUTE FUNCTION "EventLodgingAssignment_refuse_delete"();
CREATE TRIGGER "EventLodgingWaitlistHistory_no_delete" BEFORE DELETE ON "EventLodgingWaitlistHistory" FOR EACH ROW EXECUTE FUNCTION "EventLodgingAssignment_refuse_delete"();

-- Placeholders: a name, at least one person, an attendee of the same event when linked, linked once, and only the link
-- and the archive ever change.
ALTER TABLE "EventLodgingPlaceholder" ADD CONSTRAINT "EventLodgingPlaceholder_name_present" CHECK (length(btrim("displayName")) > 0);
ALTER TABLE "EventLodgingPlaceholder" ADD CONSTRAINT "EventLodgingPlaceholder_headcount_positive" CHECK ("headcount" >= 1);
ALTER TABLE "EventLodgingPlaceholder" ADD CONSTRAINT "EventLodgingPlaceholder_link_fields" CHECK (("linkedAttendeeId" IS NULL) = ("linkedAt" IS NULL));

CREATE FUNCTION "EventLodgingPlaceholder_guard"() RETURNS trigger AS $$
DECLARE
  changeable CONSTANT text[] := ARRAY['linkedAttendeeId', 'linkedAt', 'linkedByUserId', 'archivedAt', 'archivedByUserId'];
BEGIN
  IF NEW."linkedAttendeeId" IS NOT NULL AND (SELECT "eventId" FROM "RegistrationAttendee" WHERE "id" = NEW."linkedAttendeeId") IS DISTINCT FROM NEW."eventId" THEN
    RAISE EXCEPTION 'A placeholder can be linked only to an attendee of its own event.' USING ERRCODE = '23001';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."linkedAttendeeId" IS NOT NULL AND (NEW."linkedAttendeeId" IS DISTINCT FROM OLD."linkedAttendeeId" OR NEW."linkedAt" IS DISTINCT FROM OLD."linkedAt") THEN
      RAISE EXCEPTION 'A placeholder is linked once.' USING ERRCODE = '23001';
    END IF;
    IF OLD."archivedAt" IS NOT NULL AND (NEW."archivedAt" IS DISTINCT FROM OLD."archivedAt") THEN
      RAISE EXCEPTION 'An archived placeholder stays archived.' USING ERRCODE = '23001';
    END IF;
    IF (to_jsonb(NEW) - changeable) <> (to_jsonb(OLD) - changeable) THEN
      RAISE EXCEPTION 'A placeholder changes only its link and its archive.' USING ERRCODE = '23001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EventLodgingPlaceholder_guard" BEFORE INSERT OR UPDATE ON "EventLodgingPlaceholder" FOR EACH ROW EXECUTE FUNCTION "EventLodgingPlaceholder_guard"();

-- Assignments: one place (a unit or a bucket) and at least one occupant, ordered nights, a head count, and a reason
-- once cancelled.
ALTER TABLE "EventLodgingAssignment" ADD CONSTRAINT "EventLodgingAssignment_one_place" CHECK (("eventLodgingUnitId" IS NULL) <> ("bucketId" IS NULL));
ALTER TABLE "EventLodgingAssignment" ADD CONSTRAINT "EventLodgingAssignment_has_occupant" CHECK ("attendeeId" IS NOT NULL OR "placeholderId" IS NOT NULL);
ALTER TABLE "EventLodgingAssignment" ADD CONSTRAINT "EventLodgingAssignment_nights" CHECK ("lastNight" >= "firstNight");
ALTER TABLE "EventLodgingAssignment" ADD CONSTRAINT "EventLodgingAssignment_people_positive" CHECK ("people" >= 1 AND ("attendeeId" IS NULL OR "people" = 1));
ALTER TABLE "EventLodgingAssignment" ADD CONSTRAINT "EventLodgingAssignment_revision_positive" CHECK ("revision" >= 1);
ALTER TABLE "EventLodgingAssignment" ADD CONSTRAINT "EventLodgingAssignment_cancel_fields" CHECK (("cancelledAt" IS NULL) = ("cancelReason" IS NULL));

-- One occupant is never in two places on the same night: an exclusion over the occupant and the night range. (A unit's
-- head count is checked night by night in the application under the unit locks and the capacity version.)
ALTER TABLE "EventLodgingAssignment" ADD CONSTRAINT "EventLodgingAssignment_occupant_nights" EXCLUDE USING gist (
  (COALESCE("attendeeId", "placeholderId")) WITH =, daterange("firstNight", "lastNight", '[]') WITH &&
) WHERE ("cancelledAt" IS NULL);

-- The attendee must be on the assignment's event.
CREATE FUNCTION "EventLodgingAssignment_same_event"() RETURNS trigger AS $$
BEGIN
  IF NEW."attendeeId" IS NOT NULL AND (SELECT "eventId" FROM "RegistrationAttendee" WHERE "id" = NEW."attendeeId") IS DISTINCT FROM NEW."eventId" THEN
    RAISE EXCEPTION 'The attendee is not on the assignment''s event.' USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EventLodgingAssignment_same_event" BEFORE INSERT OR UPDATE OF "attendeeId", "eventId" ON "EventLodgingAssignment" FOR EACH ROW EXECUTE FUNCTION "EventLodgingAssignment_same_event"();

-- A cancelled assignment never changes again; every other change raises the revision (and the deferred check below
-- insists that the same transaction appended the history row for that revision).
CREATE FUNCTION "EventLodgingAssignment_guard"() RETURNS trigger AS $$
BEGIN
  IF OLD."cancelledAt" IS NOT NULL THEN
    RAISE EXCEPTION 'A cancelled lodging assignment never changes.' USING ERRCODE = '23001';
  END IF;
  IF NEW."eventId" IS DISTINCT FROM OLD."eventId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'An assignment''s event and creation time cannot change.' USING ERRCODE = '23001';
  END IF;
  IF NEW."revision" <= OLD."revision" THEN
    RAISE EXCEPTION 'Every change to a lodging assignment raises its revision.' USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EventLodgingAssignment_guard" BEFORE UPDATE ON "EventLodgingAssignment" FOR EACH ROW EXECUTE FUNCTION "EventLodgingAssignment_guard"();

CREATE FUNCTION "EventLodgingAssignment_requires_history"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "EventLodgingAssignmentHistory" WHERE "assignmentId" = NEW."id" AND "revision" = NEW."revision") THEN
    RAISE EXCEPTION 'Every change to a lodging assignment must append its history row.' USING ERRCODE = '23001';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "EventLodgingAssignment_requires_history" AFTER INSERT OR UPDATE ON "EventLodgingAssignment" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "EventLodgingAssignment_requires_history"();

-- History, notices and waitlist history are append-only (deletes are refused above unless the event is gone).
ALTER TABLE "EventLodgingAssignmentHistory" ADD CONSTRAINT "EventLodgingAssignmentHistory_revision_positive" CHECK ("revision" >= 1 AND "people" >= 1);
CREATE FUNCTION "EventLodgingAssignment_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Lodging assignment history is append-only.' USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EventLodgingAssignmentHistory_append_only" BEFORE UPDATE ON "EventLodgingAssignmentHistory" FOR EACH ROW EXECUTE FUNCTION "EventLodgingAssignment_append_only"();
CREATE TRIGGER "EventLodgingAssignmentNotice_append_only" BEFORE UPDATE ON "EventLodgingAssignmentNotice" FOR EACH ROW EXECUTE FUNCTION "EventLodgingAssignment_append_only"();
CREATE TRIGGER "EventLodgingWaitlistHistory_append_only" BEFORE UPDATE ON "EventLodgingWaitlistHistory" FOR EACH ROW EXECUTE FUNCTION "EventLodgingAssignment_append_only"();

-- A notice is for a registration on its own event.
ALTER TABLE "EventLodgingAssignmentNotice" ADD CONSTRAINT "EventLodgingAssignmentNotice_version_positive" CHECK ("assignmentVersion" >= 0);
CREATE FUNCTION "EventLodgingAssignmentNotice_same_event"() RETURNS trigger AS $$
BEGIN
  IF (SELECT "eventId" FROM "Registration" WHERE "id" = NEW."registrationId") IS DISTINCT FROM NEW."eventId" THEN
    RAISE EXCEPTION 'The registration is not on the notice''s event.' USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EventLodgingAssignmentNotice_same_event" BEFORE INSERT ON "EventLodgingAssignmentNotice" FOR EACH ROW EXECUTE FUNCTION "EventLodgingAssignmentNotice_same_event"();

-- Waitlist entries: valid party and nights, an expiry on an open offer, one open entry per registration, a registration of
-- the same event, immutable asks, and only the moves the lifecycle allows.
ALTER TABLE "EventLodgingWaitlistEntry" ADD CONSTRAINT "EventLodgingWaitlistEntry_party_positive" CHECK ("partySize" >= 1);
ALTER TABLE "EventLodgingWaitlistEntry" ADD CONSTRAINT "EventLodgingWaitlistEntry_nights" CHECK (
  (("firstNight" IS NULL) = ("lastNight" IS NULL)) AND ("firstNight" IS NULL OR "lastNight" >= "firstNight")
);
ALTER TABLE "EventLodgingWaitlistEntry" ADD CONSTRAINT "EventLodgingWaitlistEntry_offer_fields" CHECK (
  "offerNumber" >= 0 AND ("status" <> 'OFFERED' OR ("offerExpiresAt" IS NOT NULL AND "offerNumber" >= 1))
);
CREATE UNIQUE INDEX "EventLodgingWaitlistEntry_open_key" ON "EventLodgingWaitlistEntry" ("registrationId") WHERE "status" IN ('JOINED', 'OFFERED', 'ACCEPTED');
ALTER TABLE "EventLodgingWaitlistHistory" ADD CONSTRAINT "EventLodgingWaitlistHistory_offer_number" CHECK ("offerNumber" >= 0);

CREATE FUNCTION "EventLodgingWaitlistEntry_guard"() RETURNS trigger AS $$
BEGIN
  IF (SELECT "eventId" FROM "Registration" WHERE "id" = NEW."registrationId") IS DISTINCT FROM NEW."eventId" THEN
    RAISE EXCEPTION 'The registration is not on the waitlist entry''s event.' USING ERRCODE = '23001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'JOINED' OR NEW."offerNumber" <> 0 THEN
      RAISE EXCEPTION 'A waitlist entry starts as joined.' USING ERRCODE = '23001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."eventId" IS DISTINCT FROM OLD."eventId" OR NEW."registrationId" IS DISTINCT FROM OLD."registrationId"
     OR NEW."category" IS DISTINCT FROM OLD."category" OR NEW."firstNight" IS DISTINCT FROM OLD."firstNight"
     OR NEW."lastNight" IS DISTINCT FROM OLD."lastNight" OR NEW."partySize" IS DISTINCT FROM OLD."partySize"
     OR NEW."createdVia" IS DISTINCT FROM OLD."createdVia" OR NEW."joinedAt" IS DISTINCT FROM OLD."joinedAt" THEN
    RAISE EXCEPTION 'What a waitlist entry asked for cannot change.' USING ERRCODE = '23001';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT (
      (OLD."status" = 'JOINED' AND NEW."status" IN ('OFFERED', 'REMOVED'))
      OR (OLD."status" = 'OFFERED' AND NEW."status" IN ('ACCEPTED', 'DECLINED', 'EXPIRED', 'REMOVED'))
      OR (OLD."status" = 'EXPIRED' AND NEW."status" IN ('OFFERED', 'REMOVED'))
      OR (OLD."status" = 'ACCEPTED' AND NEW."status" IN ('PROMOTED', 'REMOVED'))
    ) THEN
      RAISE EXCEPTION 'A waitlist entry cannot move from % to %.', OLD."status", NEW."status" USING ERRCODE = '23001';
    END IF;
    IF NEW."status" = 'OFFERED' AND NEW."offerNumber" <> OLD."offerNumber" + 1 THEN
      RAISE EXCEPTION 'Each offer is the next offer number.' USING ERRCODE = '23001';
    END IF;
    IF NEW."status" <> 'OFFERED' AND NEW."offerNumber" <> OLD."offerNumber" THEN
      RAISE EXCEPTION 'Only an offer raises the offer number.' USING ERRCODE = '23001';
    END IF;
  ELSIF NEW."offerNumber" IS DISTINCT FROM OLD."offerNumber" THEN
    RAISE EXCEPTION 'Only an offer raises the offer number.' USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EventLodgingWaitlistEntry_guard" BEFORE INSERT OR UPDATE ON "EventLodgingWaitlistEntry" FOR EACH ROW EXECUTE FUNCTION "EventLodgingWaitlistEntry_guard"();

-- Every change of a waitlist entry's state appends its history row in the same transaction.
CREATE FUNCTION "EventLodgingWaitlistEntry_requires_history"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "EventLodgingWaitlistHistory" WHERE "entryId" = NEW."id" AND "status" = NEW."status" AND "offerNumber" = NEW."offerNumber") THEN
    RAISE EXCEPTION 'Every change to a lodging waitlist entry must append its history row.' USING ERRCODE = '23001';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "EventLodgingWaitlistEntry_requires_history" AFTER INSERT OR UPDATE ON "EventLodgingWaitlistEntry" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "EventLodgingWaitlistEntry_requires_history"();
