-- Lodging pricing follow-ups (#803): the registrant chooses how many rooms, a party larger than the beds in those rooms
-- acknowledges bringing extra bedding, and a waitlist entry carries the room count it wants. Capacity of room-type
-- categories is counted in rooms. Nothing existing is rewritten: every earlier row reads as one room, no extra bedding.

ALTER TABLE "EventLodgingRequestVersion" ADD COLUMN "roomCount" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "EventLodgingRequestVersion" ADD COLUMN "bringsExtraBedding" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "EventLodgingChangeRequest" ADD COLUMN "roomCount" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "EventLodgingChangeRequest" ADD COLUMN "bringsExtraBedding" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "EventLodgingWaitlistEntry" ADD COLUMN "roomCount" INTEGER NOT NULL DEFAULT 1;

-- BACKFILL START
-- Rows that exist before this change were priced and counted under the interim rule: a party was charged for
-- ceil(party / the smallest "sleeps up to" of the category's rooms) rooms. Reading them all as one room would silently
-- change what they hold, so each takes that room count, deterministically, from data already stored:
--   1. the room count the stored lodging line itself names ("Lodging: Dorm room (3 rooms)"), for a request's first version
--      from the registration form (the only version that price was ever worked out for); else
--   2. ceil(party / smallest default capacity of the event's assignable, non-retired ROOM units of that category), for a
--      category whose every non-retired unit is a numbered room. Any other category stays one unit.
-- (Every UPDATE also honours the transaction-local setting imsda.backfill_event, which is unset when the migration runs, so it
-- covers every row; the real-database check sets it to run exactly this SQL on rows of its own event.)
-- A backfilled party that is larger than its beds gets no extra-bedding acknowledgement (nobody gave one); the application
-- asks for it only when the registrant changes the rooms or the party. The statements end with a semicolon at the end of a
-- line and hold none inside, because the real-database check runs this block against rows it makes.
ALTER TABLE "EventLodgingRequestVersion" DISABLE TRIGGER "EventLodgingRequestVersion_append_only";
ALTER TABLE "EventLodgingChangeRequest" DISABLE TRIGGER "EventLodgingChangeRequest_guard";
ALTER TABLE "EventLodgingWaitlistEntry" DISABLE TRIGGER "EventLodgingWaitlistEntry_requires_history";
ALTER TABLE "EventLodgingWaitlistEntry" DISABLE TRIGGER "EventLodgingWaitlistEntry_guard";

CREATE TEMPORARY TABLE "_lodging_room_sleeps" ON COMMIT DROP AS
SELECT el."eventId", u."category", MIN(eu."defaultCapacity") AS "sleeps"
FROM "EventLodgingUnit" eu
JOIN "EventLodging" el ON el."id" = eu."eventLodgingId"
JOIN "LodgingUnit" u ON u."id" = eu."unitId"
WHERE eu."retired" = false AND eu."assignable" = true AND eu."defaultCapacity" > 0 AND u."kind" = 'ROOM' AND u."isArea" = false AND u."category" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "EventLodgingUnit" other JOIN "LodgingUnit" ou ON ou."id" = other."unitId"
    WHERE other."eventLodgingId" = el."id" AND other."retired" = false AND ou."category" = u."category" AND (ou."kind" <> 'ROOM' OR ou."isArea" = true)
  )
GROUP BY el."eventId", u."category";

UPDATE "EventLodgingRequestVersion" v SET "roomCount" = LEAST(v."partySize", GREATEST(1, CEIL(v."partySize"::numeric / s."sleeps")::int))
FROM "_lodging_room_sleeps" s WHERE s."eventId" = v."eventId" AND s."category" = v."category" AND (current_setting('imsda.backfill_event', true) IS NULL OR current_setting('imsda.backfill_event', true) = '' OR v."eventId" = current_setting('imsda.backfill_event', true));

UPDATE "EventLodgingRequestVersion" v SET "roomCount" = LEAST(v."partySize", GREATEST(1, (regexp_match(li.value ->> 'label', '\((\d+) rooms\)'))[1]::int))
FROM "EventLodgingRequest" r, "PublicRegistrationSubmission" ps, jsonb_array_elements(CASE WHEN jsonb_typeof(ps."pricingSnapshot" -> 'lineItems') = 'array' THEN ps."pricingSnapshot" -> 'lineItems' ELSE '[]'::jsonb END) AS li(value)
WHERE r."id" = v."requestId" AND ps."registrationId" = r."registrationId" AND v."version" = 1 AND v."source" = 'REGISTRATION_FORM'
  AND li.value ->> 'key' = 'lodging' AND li.value ->> 'label' ~ '\(\d+ rooms\)' AND v."category" IN ('DORM_ROOM', 'CONFERENCE_CENTER_ROOM') AND (current_setting('imsda.backfill_event', true) IS NULL OR current_setting('imsda.backfill_event', true) = '' OR v."eventId" = current_setting('imsda.backfill_event', true));

UPDATE "EventLodgingChangeRequest" c SET "roomCount" = LEAST(c."partySize", GREATEST(1, CEIL(c."partySize"::numeric / s."sleeps")::int))
FROM "_lodging_room_sleeps" s WHERE s."eventId" = c."eventId" AND s."category" = c."category" AND (current_setting('imsda.backfill_event', true) IS NULL OR current_setting('imsda.backfill_event', true) = '' OR c."eventId" = current_setting('imsda.backfill_event', true));

UPDATE "EventLodgingWaitlistEntry" w SET "roomCount" = LEAST(w."partySize", GREATEST(1, CEIL(w."partySize"::numeric / s."sleeps")::int))
FROM "_lodging_room_sleeps" s WHERE s."eventId" = w."eventId" AND s."category" = w."category" AND (current_setting('imsda.backfill_event', true) IS NULL OR current_setting('imsda.backfill_event', true) = '' OR w."eventId" = current_setting('imsda.backfill_event', true));

ALTER TABLE "EventLodgingRequestVersion" ENABLE TRIGGER "EventLodgingRequestVersion_append_only";
ALTER TABLE "EventLodgingChangeRequest" ENABLE TRIGGER "EventLodgingChangeRequest_guard";
ALTER TABLE "EventLodgingWaitlistEntry" ENABLE TRIGGER "EventLodgingWaitlistEntry_requires_history";
ALTER TABLE "EventLodgingWaitlistEntry" ENABLE TRIGGER "EventLodgingWaitlistEntry_guard";
-- BACKFILL END

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
