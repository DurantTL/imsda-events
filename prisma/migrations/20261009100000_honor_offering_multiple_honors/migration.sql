-- One Honors Weekend class can teach several catalog honors (#812). Additive:
-- a join table plus a column on the completion links, both backfilled from the
-- single honor every class and link has today. `HonorOffering.honorId` stays as
-- the class's PRIMARY honor (position 0), so every existing reader keeps working.
-- Hand-written parts (partial indexes, triggers) are left alone by
-- `prisma migrate diff`.

-- CreateTable
CREATE TABLE "HonorOfferingHonor" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "honorId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "sessionId" TEXT,
    "locationId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HonorOfferingHonor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HonorOfferingHonor_offeringId_honorId_key" ON "HonorOfferingHonor"("offeringId", "honorId");
CREATE UNIQUE INDEX "HonorOfferingHonor_sessionId_honorId_key" ON "HonorOfferingHonor"("sessionId", "honorId");
CREATE INDEX "HonorOfferingHonor_honorId_idx" ON "HonorOfferingHonor"("honorId");
CREATE INDEX "HonorOfferingHonor_eventId_honorId_idx" ON "HonorOfferingHonor"("eventId", "honorId");

-- AddForeignKey
ALTER TABLE "HonorOfferingHonor" ADD CONSTRAINT "HonorOfferingHonor_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "HonorOffering"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HonorOfferingHonor" ADD CONSTRAINT "HonorOfferingHonor_honorId_fkey" FOREIGN KEY ("honorId") REFERENCES "Honor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: every existing class teaches exactly its one honor, as position 0.
-- A class that already has a row is skipped, so the statement is safe to run again.
INSERT INTO "HonorOfferingHonor" ("id", "offeringId", "honorId", "eventId", "sessionId", "locationId", "position")
SELECT 'hoh_' || o."id", o."id", o."honorId", o."eventId", o."sessionId", o."locationId", 0
FROM "HonorOffering" o
WHERE NOT EXISTS (SELECT 1 FROM "HonorOfferingHonor" h WHERE h."offeringId" = o."id");

-- Uniqueness moves from the class (one honor) to the honors a class teaches.
-- The rules are the ones the class had, applied per honor: no honor twice in
-- one session (above: unique on sessionId + honorId); one all-sessions class
-- per honor per event when it has no site, and per honor per site otherwise.
-- Two classes may still teach the same honor in different sessions, and one
-- honor may be taught in a single-session class and, separately, at another
-- site. The old indexes accepted exactly the rows the new ones do for a class
-- with one honor, so nothing that exists today can violate them.
DROP INDEX "HonorOffering_sessionId_honorId_key";
DROP INDEX "HonorOffering_eventId_honorId_all_sessions_no_location_key";
DROP INDEX "HonorOffering_eventId_honorId_locationId_all_sessions_key";

CREATE UNIQUE INDEX "HonorOfferingHonor_eventId_honorId_all_sessions_no_location_key"
  ON "HonorOfferingHonor"("eventId", "honorId") WHERE "sessionId" IS NULL AND "locationId" IS NULL;

CREATE UNIQUE INDEX "HonorOfferingHonor_eventId_honorId_locationId_all_sessions_key"
  ON "HonorOfferingHonor"("eventId", "honorId", "locationId") WHERE "sessionId" IS NULL AND "locationId" IS NOT NULL;

-- A class always teaches its primary honor, and the join row copies the class's
-- own event, session and site. Triggers keep that true however a class is
-- written: a new class gets its position-0 row (the repository adds the rest),
-- and a class that moves takes its rows with it.
CREATE FUNCTION "honor_offering_primary_row"() RETURNS trigger AS $$
BEGIN
  INSERT INTO "HonorOfferingHonor" ("id", "offeringId", "honorId", "eventId", "sessionId", "locationId", "position")
  VALUES ('hoh_' || NEW."id", NEW."id", NEW."honorId", NEW."eventId", NEW."sessionId", NEW."locationId", 0)
  ON CONFLICT ("offeringId", "honorId") DO NOTHING;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "HonorOffering_primary_row"
  AFTER INSERT ON "HonorOffering"
  FOR EACH ROW EXECUTE FUNCTION "honor_offering_primary_row"();

CREATE FUNCTION "honor_offering_follow_placement"() RETURNS trigger AS $$
BEGIN
  UPDATE "HonorOfferingHonor"
  SET "sessionId" = NEW."sessionId", "locationId" = NEW."locationId"
  WHERE "offeringId" = NEW."id";
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "HonorOffering_follow_placement"
  AFTER UPDATE OF "sessionId", "locationId" ON "HonorOffering"
  FOR EACH ROW EXECUTE FUNCTION "honor_offering_follow_placement"();

CREATE FUNCTION "honor_offering_honor_copy_placement"() RETURNS trigger AS $$
DECLARE
  offering "HonorOffering"%ROWTYPE;
BEGIN
  SELECT * INTO offering FROM "HonorOffering" WHERE "id" = NEW."offeringId";
  NEW."eventId" := offering."eventId";
  NEW."sessionId" := offering."sessionId";
  NEW."locationId" := offering."locationId";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "HonorOfferingHonor_copy_placement"
  BEFORE INSERT ON "HonorOfferingHonor"
  FOR EACH ROW EXECUTE FUNCTION "honor_offering_honor_copy_placement"();

-- Completion links: one per honor a class teaches. An existing link is for the
-- honor of the member record it points at; only if that record were somehow
-- missing does it fall back to the class's one honor.
ALTER TABLE "HonorWeekendCompletionLink" ADD COLUMN "honorId" TEXT;

UPDATE "HonorWeekendCompletionLink" l
SET "honorId" = COALESCE(
  (SELECT m."honorId" FROM "MemberHonorEntry" m WHERE m."id" = l."memberHonorEntryId"),
  (SELECT o."honorId" FROM "HonorEnrollment" e JOIN "HonorOffering" o ON o."id" = e."offeringId" WHERE e."id" = l."enrollmentId")
);

ALTER TABLE "HonorWeekendCompletionLink" ALTER COLUMN "honorId" SET NOT NULL;

DROP INDEX "HonorWeekendCompletionLink_enrollmentId_key";
CREATE UNIQUE INDEX "HonorWeekendCompletionLink_enrollmentId_honorId_key" ON "HonorWeekendCompletionLink"("enrollmentId", "honorId");
CREATE INDEX "HonorWeekendCompletionLink_honorId_idx" ON "HonorWeekendCompletionLink"("honorId");
ALTER TABLE "HonorWeekendCompletionLink" ADD CONSTRAINT "HonorWeekendCompletionLink_honorId_fkey" FOREIGN KEY ("honorId") REFERENCES "Honor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
