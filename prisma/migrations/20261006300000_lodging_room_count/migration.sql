-- Lodging pricing follow-ups (#803): the registrant chooses how many rooms, a party larger than the beds in those rooms
-- acknowledges bringing extra bedding, and a waitlist entry carries the room count it wants. Capacity of room-type
-- categories is counted in rooms. Nothing existing is rewritten: every earlier row reads as one room, no extra bedding.

ALTER TABLE "EventLodgingRequestVersion" ADD COLUMN "roomCount" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "EventLodgingRequestVersion" ADD COLUMN "bringsExtraBedding" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "EventLodgingChangeRequest" ADD COLUMN "roomCount" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "EventLodgingChangeRequest" ADD COLUMN "bringsExtraBedding" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "EventLodgingWaitlistEntry" ADD COLUMN "roomCount" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "EventLodgingRequestVersion" ADD CONSTRAINT "EventLodgingRequestVersion_rooms_positive" CHECK ("roomCount" >= 1 AND "roomCount" <= "partySize");
ALTER TABLE "EventLodgingChangeRequest" ADD CONSTRAINT "EventLodgingChangeRequest_rooms_positive" CHECK ("roomCount" >= 1);
ALTER TABLE "EventLodgingWaitlistEntry" ADD CONSTRAINT "EventLodgingWaitlistEntry_rooms_positive" CHECK ("roomCount" >= 1);

-- What a waitlist entry asked for never changes, and that now includes the rooms (the same function, one more column).
CREATE OR REPLACE FUNCTION "EventLodgingWaitlistEntry_guard"() RETURNS trigger AS $$
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
     OR NEW."roomCount" IS DISTINCT FROM OLD."roomCount"
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
