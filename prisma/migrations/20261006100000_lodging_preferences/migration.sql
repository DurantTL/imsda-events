-- CreateEnum
CREATE TYPE "LodgingFullBehavior" AS ENUM ('SHOW_FULL', 'WAITLIST');

-- CreateEnum
CREATE TYPE "LodgingRequestSource" AS ENUM ('REGISTRANT', 'STAFF', 'REGISTRATION_FORM');

-- CreateEnum
CREATE TYPE "LodgingHouseholdPreference" AS ENUM ('TOGETHER', 'FLEXIBLE');

-- CreateEnum
CREATE TYPE "LodgingRoommateDecision" AS ENUM ('PENDING', 'APPROVED', 'DECLINED');

-- CreateEnum
CREATE TYPE "LodgingRuleKind" AS ENUM ('KEEP_TOGETHER', 'SPLIT_HOUSEHOLD', 'SEPARATE');

-- AlterTable
ALTER TABLE "EventLodging" ADD COLUMN     "collectsPreferences" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "fullBehavior" "LodgingFullBehavior" NOT NULL DEFAULT 'SHOW_FULL',
ADD COLUMN     "preferencesDeadline" DATE,
ADD COLUMN     "settingsUpdatedByUserId" TEXT;

-- CreateTable
CREATE TABLE "EventLodgingRequest" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "currentVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventLodgingRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventLodgingRequestVersion" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "category" "LodgingCategory",
    "firstNight" DATE,
    "lastNight" DATE,
    "partySize" INTEGER NOT NULL,
    "groundFloorNeeded" BOOLEAN NOT NULL DEFAULT false,
    "accessibleRoomNeeded" BOOLEAN NOT NULL DEFAULT false,
    "privateRoomRequested" BOOLEAN NOT NULL DEFAULT false,
    "householdPreference" "LodgingHouseholdPreference" NOT NULL DEFAULT 'TOGETHER',
    "source" "LodgingRequestSource" NOT NULL,
    "sourceFormVersionId" TEXT,
    "actorUserId" TEXT,
    "accessTokenId" TEXT,
    "changeReason" TEXT,
    "afterDeadline" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventLodgingRequestVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventLodgingRoommateRequest" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "fromRegistrationId" TEXT NOT NULL,
    "targetRegistrationId" TEXT NOT NULL,
    "fromPersonId" TEXT,
    "targetPersonId" TEXT,
    "source" "LodgingRequestSource" NOT NULL,
    "actorUserId" TEXT,
    "accessTokenId" TEXT,
    "decision" "LodgingRoommateDecision" NOT NULL DEFAULT 'PENDING',
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "decisionReason" TEXT,
    "withdrawnAt" TIMESTAMP(3),
    "withdrawnByUserId" TEXT,
    "withdrawalReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventLodgingRoommateRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventLodgingRule" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "kind" "LodgingRuleKind" NOT NULL,
    "personAId" TEXT NOT NULL,
    "personBId" TEXT,
    "reason" TEXT NOT NULL,
    "actorUserId" TEXT,
    "effectiveFrom" DATE,
    "effectiveUntil" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endedByUserId" TEXT,
    "endReason" TEXT,

    CONSTRAINT "EventLodgingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventLodgingReviewAck" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventLodgingReviewAck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventLodgingChangeRequest" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "category" "LodgingCategory",
    "firstNight" DATE,
    "lastNight" DATE,
    "partySize" INTEGER NOT NULL,
    "privateRoomRequested" BOOLEAN NOT NULL DEFAULT false,
    "householdPreference" "LodgingHouseholdPreference" NOT NULL DEFAULT 'TOGETHER',
    "accessTokenId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "resolution" TEXT,

    CONSTRAINT "EventLodgingChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventLodgingRequest_eventId_registrationId_key" ON "EventLodgingRequest"("eventId", "registrationId");

-- CreateIndex
CREATE UNIQUE INDEX "EventLodgingRequest_id_eventId_key" ON "EventLodgingRequest"("id", "eventId");

-- CreateIndex
CREATE INDEX "EventLodgingRequestVersion_eventId_category_idx" ON "EventLodgingRequestVersion"("eventId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "EventLodgingRequestVersion_requestId_version_key" ON "EventLodgingRequestVersion"("requestId", "version");

-- CreateIndex
CREATE INDEX "EventLodgingRoommateRequest_eventId_fromRegistrationId_idx" ON "EventLodgingRoommateRequest"("eventId", "fromRegistrationId");

-- CreateIndex
CREATE INDEX "EventLodgingRoommateRequest_eventId_targetRegistrationId_idx" ON "EventLodgingRoommateRequest"("eventId", "targetRegistrationId");

-- CreateIndex
CREATE INDEX "EventLodgingRule_eventId_kind_idx" ON "EventLodgingRule"("eventId", "kind");

-- CreateIndex
CREATE INDEX "EventLodgingRule_personAId_idx" ON "EventLodgingRule"("personAId");

-- CreateIndex
CREATE INDEX "EventLodgingRule_personBId_idx" ON "EventLodgingRule"("personBId");

-- CreateIndex
CREATE UNIQUE INDEX "EventLodgingReviewAck_eventId_itemKey_fingerprint_key" ON "EventLodgingReviewAck"("eventId", "itemKey", "fingerprint");

-- CreateIndex
CREATE INDEX "EventLodgingChangeRequest_eventId_resolvedAt_idx" ON "EventLodgingChangeRequest"("eventId", "resolvedAt");

-- CreateIndex
CREATE INDEX "EventLodgingChangeRequest_registrationId_idx" ON "EventLodgingChangeRequest"("registrationId");

-- AddForeignKey
ALTER TABLE "EventLodgingRequest" ADD CONSTRAINT "EventLodgingRequest_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingRequest" ADD CONSTRAINT "EventLodgingRequest_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingRequestVersion" ADD CONSTRAINT "EventLodgingRequestVersion_requestId_eventId_fkey" FOREIGN KEY ("requestId", "eventId") REFERENCES "EventLodgingRequest"("id", "eventId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingRoommateRequest" ADD CONSTRAINT "EventLodgingRoommateRequest_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingRoommateRequest" ADD CONSTRAINT "EventLodgingRoommateRequest_fromRegistrationId_fkey" FOREIGN KEY ("fromRegistrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingRoommateRequest" ADD CONSTRAINT "EventLodgingRoommateRequest_targetRegistrationId_fkey" FOREIGN KEY ("targetRegistrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingRoommateRequest" ADD CONSTRAINT "EventLodgingRoommateRequest_fromPersonId_fkey" FOREIGN KEY ("fromPersonId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingRoommateRequest" ADD CONSTRAINT "EventLodgingRoommateRequest_targetPersonId_fkey" FOREIGN KEY ("targetPersonId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingRule" ADD CONSTRAINT "EventLodgingRule_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingRule" ADD CONSTRAINT "EventLodgingRule_personAId_fkey" FOREIGN KEY ("personAId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingRule" ADD CONSTRAINT "EventLodgingRule_personBId_fkey" FOREIGN KEY ("personBId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingReviewAck" ADD CONSTRAINT "EventLodgingReviewAck_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingChangeRequest" ADD CONSTRAINT "EventLodgingChangeRequest_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLodgingChangeRequest" ADD CONSTRAINT "EventLodgingChangeRequest_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Constraints Prisma cannot express (#199). Additive only.
-- ---------------------------------------------------------------------------

ALTER TABLE "EventLodgingRequest" ADD CONSTRAINT "EventLodgingRequest_version_positive" CHECK ("currentVersion" >= 1);
ALTER TABLE "EventLodgingRequestVersion" ADD CONSTRAINT "EventLodgingRequestVersion_version_positive" CHECK ("version" >= 1);
ALTER TABLE "EventLodgingRequestVersion" ADD CONSTRAINT "EventLodgingRequestVersion_party_positive" CHECK ("partySize" >= 1);
ALTER TABLE "EventLodgingRequestVersion" ADD CONSTRAINT "EventLodgingRequestVersion_nights" CHECK (
  (("firstNight" IS NULL) = ("lastNight" IS NULL)) AND ("firstNight" IS NULL OR "lastNight" >= "firstNight")
);

-- A request's registration must be on the request's event.
CREATE FUNCTION "EventLodgingRequest_same_event"() RETURNS trigger AS $$
BEGIN
  IF (SELECT "eventId" FROM "Registration" WHERE "id" = NEW."registrationId") IS DISTINCT FROM NEW."eventId" THEN
    RAISE EXCEPTION 'The registration is not on the request''s event.' USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EventLodgingRequest_same_event" BEFORE INSERT OR UPDATE OF "registrationId", "eventId" ON "EventLodgingRequest" FOR EACH ROW EXECUTE FUNCTION "EventLodgingRequest_same_event"();

-- A request and its versions are never deleted on their own; they go with their registration or event.
CREATE FUNCTION "EventLodgingRequest_refuse_delete"() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 AND (
    NOT EXISTS (SELECT 1 FROM "Event" WHERE "id" = OLD."eventId")
    OR NOT EXISTS (SELECT 1 FROM "Registration" WHERE "id" = OLD."registrationId")
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'A lodging request is never deleted.' USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EventLodgingRequest_no_delete" BEFORE DELETE ON "EventLodgingRequest" FOR EACH ROW EXECUTE FUNCTION "EventLodgingRequest_refuse_delete"();

-- Versions are snapshots: never rewritten, never deleted on their own.
CREATE FUNCTION "EventLodgingRequestVersion_append_only"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 AND NOT EXISTS (SELECT 1 FROM "EventLodgingRequest" WHERE "id" = OLD."requestId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Lodging request versions are append-only.' USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EventLodgingRequestVersion_append_only" BEFORE UPDATE OR DELETE ON "EventLodgingRequestVersion" FOR EACH ROW EXECUTE FUNCTION "EventLodgingRequestVersion_append_only"();

-- Roommate requests: both registrations on the event, a person (when named) an attendee of that registration,
-- and a request to someone on the same registration must name two different people.
ALTER TABLE "EventLodgingRoommateRequest" ADD CONSTRAINT "EventLodgingRoommateRequest_distinct" CHECK (
  "fromRegistrationId" <> "targetRegistrationId"
  OR ("fromPersonId" IS NOT NULL AND "targetPersonId" IS NOT NULL AND "fromPersonId" <> "targetPersonId")
);
ALTER TABLE "EventLodgingRoommateRequest" ADD CONSTRAINT "EventLodgingRoommateRequest_decision_fields" CHECK (
  ("decision" = 'PENDING') = ("decidedAt" IS NULL)
);
ALTER TABLE "EventLodgingRoommateRequest" ADD CONSTRAINT "EventLodgingRoommateRequest_withdrawal_fields" CHECK (
  ("withdrawnAt" IS NULL) = ("withdrawalReason" IS NULL)
);

-- One open (not withdrawn) request per pair of registrations and named people.
CREATE UNIQUE INDEX "EventLodgingRoommateRequest_open_key" ON "EventLodgingRoommateRequest"
  ("eventId", "fromRegistrationId", "targetRegistrationId", COALESCE("fromPersonId", ''), COALESCE("targetPersonId", ''))
  WHERE "withdrawnAt" IS NULL;

CREATE FUNCTION "EventLodgingRoommateRequest_same_event"() RETURNS trigger AS $$
BEGIN
  IF (SELECT "eventId" FROM "Registration" WHERE "id" = NEW."fromRegistrationId") IS DISTINCT FROM NEW."eventId"
     OR (SELECT "eventId" FROM "Registration" WHERE "id" = NEW."targetRegistrationId") IS DISTINCT FROM NEW."eventId" THEN
    RAISE EXCEPTION 'Both registrations must be on the request''s event.' USING ERRCODE = '23001';
  END IF;
  IF NEW."fromPersonId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "RegistrationAttendee" WHERE "registrationId" = NEW."fromRegistrationId" AND "personId" = NEW."fromPersonId") THEN
    RAISE EXCEPTION 'The person is not an attendee of the requesting registration.' USING ERRCODE = '23001';
  END IF;
  IF NEW."targetPersonId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "RegistrationAttendee" WHERE "registrationId" = NEW."targetRegistrationId" AND "personId" = NEW."targetPersonId") THEN
    RAISE EXCEPTION 'The person is not an attendee of the target registration.' USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EventLodgingRoommateRequest_same_event" BEFORE INSERT ON "EventLodgingRoommateRequest" FOR EACH ROW EXECUTE FUNCTION "EventLodgingRoommateRequest_same_event"();

-- Who asked, whom and when never change; only the decision and the withdrawal do. Rows are never deleted on their own.
CREATE FUNCTION "EventLodgingRoommateRequest_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 AND (
      NOT EXISTS (SELECT 1 FROM "Event" WHERE "id" = OLD."eventId")
      OR NOT EXISTS (SELECT 1 FROM "Registration" WHERE "id" = OLD."fromRegistrationId")
      OR NOT EXISTS (SELECT 1 FROM "Registration" WHERE "id" = OLD."targetRegistrationId")
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'A roommate request is withdrawn, never deleted.' USING ERRCODE = '23001';
  END IF;
  IF NEW."eventId" IS DISTINCT FROM OLD."eventId" OR NEW."fromRegistrationId" IS DISTINCT FROM OLD."fromRegistrationId"
     OR NEW."targetRegistrationId" IS DISTINCT FROM OLD."targetRegistrationId" OR NEW."fromPersonId" IS DISTINCT FROM OLD."fromPersonId"
     OR NEW."targetPersonId" IS DISTINCT FROM OLD."targetPersonId" OR NEW."source" IS DISTINCT FROM OLD."source"
     OR NEW."actorUserId" IS DISTINCT FROM OLD."actorUserId" OR NEW."accessTokenId" IS DISTINCT FROM OLD."accessTokenId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'A roommate request''s parties and source cannot be changed.' USING ERRCODE = '23001';
  END IF;
  IF OLD."decision" <> 'PENDING' AND (
       NEW."decision" IS DISTINCT FROM OLD."decision" OR NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt"
       OR NEW."decidedByUserId" IS DISTINCT FROM OLD."decidedByUserId" OR NEW."decisionReason" IS DISTINCT FROM OLD."decisionReason") THEN
    RAISE EXCEPTION 'A staff decision on a roommate request is final.' USING ERRCODE = '23001';
  END IF;
  IF OLD."withdrawnAt" IS NOT NULL AND (NEW."withdrawnAt" IS DISTINCT FROM OLD."withdrawnAt" OR NEW."withdrawalReason" IS DISTINCT FROM OLD."withdrawalReason") THEN
    RAISE EXCEPTION 'A withdrawn roommate request is final.' USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EventLodgingRoommateRequest_guard" BEFORE UPDATE OR DELETE ON "EventLodgingRoommateRequest" FOR EACH ROW EXECUTE FUNCTION "EventLodgingRoommateRequest_guard"();

-- Rules: a split names one person; the other kinds name an ordered pair of two different people. Reasons are required.
ALTER TABLE "EventLodgingRule" ADD CONSTRAINT "EventLodgingRule_people" CHECK (
  ("kind" = 'SPLIT_HOUSEHOLD' AND "personBId" IS NULL)
  OR ("kind" <> 'SPLIT_HOUSEHOLD' AND "personBId" IS NOT NULL AND "personAId" < "personBId")
);
ALTER TABLE "EventLodgingRule" ADD CONSTRAINT "EventLodgingRule_reason_present" CHECK (length(btrim("reason")) > 0);
ALTER TABLE "EventLodgingRule" ADD CONSTRAINT "EventLodgingRule_window" CHECK ("effectiveFrom" IS NULL OR "effectiveUntil" IS NULL OR "effectiveUntil" >= "effectiveFrom");
ALTER TABLE "EventLodgingRule" ADD CONSTRAINT "EventLodgingRule_end_fields" CHECK (("endedAt" IS NULL) = ("endReason" IS NULL));
ALTER TABLE "EventLodgingReviewAck" ADD CONSTRAINT "EventLodgingReviewAck_note_present" CHECK (length(btrim("note")) > 0);

CREATE FUNCTION "EventLodgingRule_people_on_event"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "RegistrationAttendee" WHERE "eventId" = NEW."eventId" AND "personId" = NEW."personAId")
     OR (NEW."personBId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "RegistrationAttendee" WHERE "eventId" = NEW."eventId" AND "personId" = NEW."personBId")) THEN
    RAISE EXCEPTION 'A lodging rule can name only people registered for the event.' USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EventLodgingRule_people_on_event" BEFORE INSERT ON "EventLodgingRule" FOR EACH ROW EXECUTE FUNCTION "EventLodgingRule_people_on_event"();

-- A rule is ended, never rewritten or deleted: only the end columns may change, once.
CREATE FUNCTION "EventLodgingRule_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 AND NOT EXISTS (SELECT 1 FROM "Event" WHERE "id" = OLD."eventId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'A lodging rule is ended, never deleted.' USING ERRCODE = '23001';
  END IF;
  IF OLD."endedAt" IS NOT NULL
     OR NEW."eventId" IS DISTINCT FROM OLD."eventId" OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."personAId" IS DISTINCT FROM OLD."personAId" OR NEW."personBId" IS DISTINCT FROM OLD."personBId"
     OR NEW."reason" IS DISTINCT FROM OLD."reason" OR NEW."actorUserId" IS DISTINCT FROM OLD."actorUserId"
     OR NEW."effectiveFrom" IS DISTINCT FROM OLD."effectiveFrom" OR NEW."effectiveUntil" IS DISTINCT FROM OLD."effectiveUntil"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'A lodging rule can only be ended, once.' USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EventLodgingRule_guard" BEFORE UPDATE OR DELETE ON "EventLodgingRule" FOR EACH ROW EXECUTE FUNCTION "EventLodgingRule_guard"();

-- Review acknowledgements are append-only.
CREATE FUNCTION "EventLodgingReviewAck_append_only"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 AND NOT EXISTS (SELECT 1 FROM "Event" WHERE "id" = OLD."eventId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Lodging review acknowledgements are append-only.' USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EventLodgingReviewAck_append_only" BEFORE UPDATE OR DELETE ON "EventLodgingReviewAck" FOR EACH ROW EXECUTE FUNCTION "EventLodgingReviewAck_append_only"();

-- Change requests: same event, never rewritten except to resolve once, never deleted on their own.
ALTER TABLE "EventLodgingChangeRequest" ADD CONSTRAINT "EventLodgingChangeRequest_party_positive" CHECK ("partySize" >= 1);
ALTER TABLE "EventLodgingChangeRequest" ADD CONSTRAINT "EventLodgingChangeRequest_nights" CHECK (
  (("firstNight" IS NULL) = ("lastNight" IS NULL)) AND ("firstNight" IS NULL OR "lastNight" >= "firstNight")
);
ALTER TABLE "EventLodgingChangeRequest" ADD CONSTRAINT "EventLodgingChangeRequest_resolution_fields" CHECK (("resolvedAt" IS NULL) = ("resolution" IS NULL));

CREATE FUNCTION "EventLodgingChangeRequest_same_event"() RETURNS trigger AS $$
BEGIN
  IF (SELECT "eventId" FROM "Registration" WHERE "id" = NEW."registrationId") IS DISTINCT FROM NEW."eventId" THEN
    RAISE EXCEPTION 'The registration is not on the change request''s event.' USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EventLodgingChangeRequest_same_event" BEFORE INSERT ON "EventLodgingChangeRequest" FOR EACH ROW EXECUTE FUNCTION "EventLodgingChangeRequest_same_event"();

CREATE FUNCTION "EventLodgingChangeRequest_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 AND (
      NOT EXISTS (SELECT 1 FROM "Event" WHERE "id" = OLD."eventId")
      OR NOT EXISTS (SELECT 1 FROM "Registration" WHERE "id" = OLD."registrationId")
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'A lodging change request is resolved, never deleted.' USING ERRCODE = '23001';
  END IF;
  IF OLD."resolvedAt" IS NOT NULL
     OR NEW."eventId" IS DISTINCT FROM OLD."eventId" OR NEW."registrationId" IS DISTINCT FROM OLD."registrationId"
     OR NEW."category" IS DISTINCT FROM OLD."category" OR NEW."firstNight" IS DISTINCT FROM OLD."firstNight"
     OR NEW."lastNight" IS DISTINCT FROM OLD."lastNight" OR NEW."partySize" IS DISTINCT FROM OLD."partySize"
     OR NEW."privateRoomRequested" IS DISTINCT FROM OLD."privateRoomRequested"
     OR NEW."householdPreference" IS DISTINCT FROM OLD."householdPreference"
     OR NEW."accessTokenId" IS DISTINCT FROM OLD."accessTokenId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'A lodging change request can only be resolved, once.' USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EventLodgingChangeRequest_guard" BEFORE UPDATE OR DELETE ON "EventLodgingChangeRequest" FOR EACH ROW EXECUTE FUNCTION "EventLodgingChangeRequest_guard"();
