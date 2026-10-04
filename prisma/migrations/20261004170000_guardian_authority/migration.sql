-- CreateEnum
CREATE TYPE "GuardianAuthoritySource" AS ENUM ('REGISTRATION_FORM', 'MANAGE_LINK', 'STAFF');

-- CreateEnum
CREATE TYPE "GuardianAuthorityState" AS ENUM ('ACTIVE', 'REVOKED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "GuardianAuthorityConflictState" AS ENUM ('OPEN', 'RESOLVED');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "ageOfMajority" INTEGER NOT NULL DEFAULT 18;

-- CreateTable
CREATE TABLE "GuardianAuthority" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "minorPersonId" TEXT NOT NULL,
    "adultPersonId" TEXT,
    "source" "GuardianAuthoritySource" NOT NULL,
    "state" "GuardianAuthorityState" NOT NULL DEFAULT 'ACTIVE',
    "declaredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "declarationReason" TEXT,
    "accessTokenId" TEXT,
    "actorUserId" TEXT,
    "actorPersonId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "revocationReason" TEXT,
    "supersededAt" TIMESTAMP(3),
    "supersededById" TEXT,

    CONSTRAINT "GuardianAuthority_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuardianAuthorityConflict" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "minorPersonId" TEXT NOT NULL,
    "claimedAdultPersonId" TEXT NOT NULL,
    "existingAuthorityId" TEXT NOT NULL,
    "declaredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "state" "GuardianAuthorityConflictState" NOT NULL DEFAULT 'OPEN',
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "resolutionReason" TEXT,

    CONSTRAINT "GuardianAuthorityConflict_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GuardianAuthority_eventId_minorPersonId_declaredAt_idx" ON "GuardianAuthority"("eventId", "minorPersonId", "declaredAt");

-- CreateIndex
CREATE INDEX "GuardianAuthority_registrationId_idx" ON "GuardianAuthority"("registrationId");

-- CreateIndex
CREATE INDEX "GuardianAuthority_adultPersonId_idx" ON "GuardianAuthority"("adultPersonId");

-- CreateIndex
CREATE INDEX "GuardianAuthorityConflict_eventId_state_idx" ON "GuardianAuthorityConflict"("eventId", "state");

-- CreateIndex
CREATE INDEX "GuardianAuthorityConflict_minorPersonId_idx" ON "GuardianAuthorityConflict"("minorPersonId");

-- AddForeignKey
ALTER TABLE "GuardianAuthority" ADD CONSTRAINT "GuardianAuthority_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardianAuthority" ADD CONSTRAINT "GuardianAuthority_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardianAuthority" ADD CONSTRAINT "GuardianAuthority_minorPersonId_fkey" FOREIGN KEY ("minorPersonId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardianAuthority" ADD CONSTRAINT "GuardianAuthority_adultPersonId_fkey" FOREIGN KEY ("adultPersonId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardianAuthority" ADD CONSTRAINT "GuardianAuthority_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardianAuthority" ADD CONSTRAINT "GuardianAuthority_actorPersonId_fkey" FOREIGN KEY ("actorPersonId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardianAuthority" ADD CONSTRAINT "GuardianAuthority_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardianAuthorityConflict" ADD CONSTRAINT "GuardianAuthorityConflict_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardianAuthorityConflict" ADD CONSTRAINT "GuardianAuthorityConflict_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardianAuthorityConflict" ADD CONSTRAINT "GuardianAuthorityConflict_minorPersonId_fkey" FOREIGN KEY ("minorPersonId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardianAuthorityConflict" ADD CONSTRAINT "GuardianAuthorityConflict_claimedAdultPersonId_fkey" FOREIGN KEY ("claimedAdultPersonId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardianAuthorityConflict" ADD CONSTRAINT "GuardianAuthorityConflict_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- #131: declared guardian authority (narrow slice). Additive only: one Event column, three enums, two
-- tables. A declaration is append-only evidence; authority is never inferred from household, surname,
-- email, canManage or the account holder. All of it is enforced here, not only in the app.

-- The age of majority is a plausible age.
ALTER TABLE "Event" ADD CONSTRAINT "Event_ageOfMajority_range" CHECK ("ageOfMajority" BETWEEN 13 AND 25);

-- A declaration names a different adult than the minor. Only staff name an adult for sure: the registration
-- form may also say "None of us" (no adult). ACTIVE rows carry no end state; REVOKED rows say when and why;
-- SUPERSEDED rows say when and by which row.
ALTER TABLE "GuardianAuthority" ADD CONSTRAINT "GuardianAuthority_manage_link_token" CHECK ("source" <> 'MANAGE_LINK' OR "accessTokenId" IS NOT NULL);
ALTER TABLE "GuardianAuthority" ADD CONSTRAINT "GuardianAuthority_adult_not_minor" CHECK ("adultPersonId" IS NULL OR "adultPersonId" <> "minorPersonId");
ALTER TABLE "GuardianAuthority" ADD CONSTRAINT "GuardianAuthority_staff_names_adult" CHECK ("source" <> 'STAFF' OR ("adultPersonId" IS NOT NULL AND "declarationReason" IS NOT NULL AND length(btrim("declarationReason")) > 0));
ALTER TABLE "GuardianAuthority" ADD CONSTRAINT "GuardianAuthority_state_fields" CHECK (
  ("state" <> 'ACTIVE' OR ("revokedAt" IS NULL AND "supersededAt" IS NULL AND "supersededById" IS NULL AND "revocationReason" IS NULL AND "revokedByUserId" IS NULL))
  AND ("state" <> 'REVOKED' OR ("revokedAt" IS NOT NULL AND "revocationReason" IS NOT NULL AND length(btrim("revocationReason")) > 0 AND "supersededAt" IS NULL AND "supersededById" IS NULL))
  AND ("state" <> 'SUPERSEDED' OR ("supersededAt" IS NOT NULL AND "supersededById" IS NOT NULL AND "revokedAt" IS NULL AND "revocationReason" IS NULL AND "revokedByUserId" IS NULL))
);

-- One ACTIVE declaration per (event, minor): parallel declarations settle here.
CREATE UNIQUE INDEX "GuardianAuthority_one_active_per_minor" ON "GuardianAuthority"("eventId", "minorPersonId") WHERE "state" = 'ACTIVE';

-- A declaration is created ACTIVE, on a registration of its event, for a minor who is on that registration.
-- A registration-form declaration may only name an adult on that same registration; a staff declaration may
-- name an adult registered on any registration of the same event. Nothing else makes authority.
-- A declaration is never edited or deleted. Allowed: ACTIVE -> SUPERSEDED (end pointer set, nothing else
-- changes); ACTIVE -> REVOKED (when and why set, nothing else changes); and, only from inside a
-- foreign-key action (pg_trigger_depth() > 1), a deleted user clearing itself from the actor columns, and the
-- rows going when their event or registration is really gone.
CREATE FUNCTION "GuardianAuthority_guard"() RETURNS trigger AS $$
DECLARE
  superseding CONSTANT text[] := ARRAY['state', 'supersededAt', 'supersededById'];
  revoking CONSTANT text[] := ARRAY['state', 'revokedAt', 'revokedByUserId', 'revocationReason'];
  user_columns CONSTANT text[] := ARRAY['actorUserId', 'revokedByUserId'];
  column_name text;
  old_json jsonb;
  new_json jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'A guardian authority declaration starts active.' USING ERRCODE = '23001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "Registration" WHERE "id" = NEW."registrationId" AND "eventId" = NEW."eventId") THEN
      RAISE EXCEPTION 'The registration is not on this event.' USING ERRCODE = '23001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "RegistrationAttendee" WHERE "registrationId" = NEW."registrationId" AND "personId" = NEW."minorPersonId") THEN
      RAISE EXCEPTION 'The minor is not on that registration.' USING ERRCODE = '23001';
    END IF;
    IF NEW."source" = 'MANAGE_LINK' AND NOT EXISTS (SELECT 1 FROM "RegistrationAccessToken" WHERE "id" = NEW."accessTokenId" AND "registrationId" = NEW."registrationId") THEN
      RAISE EXCEPTION 'The access grant is not for that registration.' USING ERRCODE = '23001';
    END IF;
    IF NEW."adultPersonId" IS NOT NULL THEN
      IF NEW."source" IN ('REGISTRATION_FORM', 'MANAGE_LINK') AND NOT EXISTS (SELECT 1 FROM "RegistrationAttendee" WHERE "registrationId" = NEW."registrationId" AND "personId" = NEW."adultPersonId") THEN
        RAISE EXCEPTION 'The adult is not on that registration.' USING ERRCODE = '23001';
      END IF;
      IF NEW."source" = 'STAFF' AND NOT EXISTS (SELECT 1 FROM "RegistrationAttendee" WHERE "eventId" = NEW."eventId" AND "personId" = NEW."adultPersonId") THEN
        RAISE EXCEPTION 'The adult is not registered for this event.' USING ERRCODE = '23001';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 AND (
      NOT EXISTS (SELECT 1 FROM "Event" WHERE "id" = OLD."eventId")
      OR NOT EXISTS (SELECT 1 FROM "Registration" WHERE "id" = OLD."registrationId")
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'A guardian authority declaration is never deleted; revoke or supersede it.' USING ERRCODE = '23001';
  END IF;
  old_json := to_jsonb(OLD);
  new_json := to_jsonb(NEW);
  IF pg_trigger_depth() > 1 AND (new_json - user_columns) = (old_json - user_columns) THEN
    FOREACH column_name IN ARRAY user_columns LOOP
      IF new_json -> column_name IS DISTINCT FROM old_json -> column_name AND new_json -> column_name <> 'null'::jsonb THEN
        RAISE EXCEPTION 'A guardian authority declaration is not rewritten.' USING ERRCODE = '23001';
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;
  IF OLD."state" = 'ACTIVE' AND NEW."state" = 'SUPERSEDED' AND (new_json - superseding) = (old_json - superseding) THEN
    RETURN NEW;
  END IF;
  IF OLD."state" = 'ACTIVE' AND NEW."state" = 'REVOKED' AND (new_json - revoking) = (old_json - revoking) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A guardian authority declaration is not rewritten; supersede or revoke it.' USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "GuardianAuthority_guard" BEFORE INSERT OR UPDATE OR DELETE ON "GuardianAuthority" FOR EACH ROW EXECUTE FUNCTION "GuardianAuthority_guard"();

-- A conflicting claim names a different adult than the minor, is opened without a resolution, and is
-- resolved once with a reason. One OPEN item per (event, minor, claiming adult): a resubmission settles here.
ALTER TABLE "GuardianAuthorityConflict" ADD CONSTRAINT "GuardianAuthorityConflict_adult_not_minor" CHECK ("claimedAdultPersonId" <> "minorPersonId");
ALTER TABLE "GuardianAuthorityConflict" ADD CONSTRAINT "GuardianAuthorityConflict_state_fields" CHECK (
  ("state" <> 'OPEN' OR ("resolvedAt" IS NULL AND "resolvedByUserId" IS NULL AND "resolutionReason" IS NULL))
  AND ("state" <> 'RESOLVED' OR ("resolvedAt" IS NOT NULL AND "resolutionReason" IS NOT NULL AND length(btrim("resolutionReason")) > 0))
);
CREATE UNIQUE INDEX "GuardianAuthorityConflict_one_open_per_claim" ON "GuardianAuthorityConflict"("eventId", "minorPersonId", "claimedAdultPersonId") WHERE "state" = 'OPEN';

CREATE FUNCTION "GuardianAuthorityConflict_guard"() RETURNS trigger AS $$
DECLARE
  resolving CONSTANT text[] := ARRAY['state', 'resolvedAt', 'resolvedByUserId', 'resolutionReason'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'OPEN' THEN
      RAISE EXCEPTION 'A guardian authority conflict starts open.' USING ERRCODE = '23001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "Registration" WHERE "id" = NEW."registrationId" AND "eventId" = NEW."eventId") THEN
      RAISE EXCEPTION 'The registration is not on this event.' USING ERRCODE = '23001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 AND (
      NOT EXISTS (SELECT 1 FROM "Event" WHERE "id" = OLD."eventId")
      OR NOT EXISTS (SELECT 1 FROM "Registration" WHERE "id" = OLD."registrationId")
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'A guardian authority conflict is never deleted; resolve it.' USING ERRCODE = '23001';
  END IF;
  IF pg_trigger_depth() > 1 AND NEW."resolvedByUserId" IS NULL AND (to_jsonb(NEW) - 'resolvedByUserId') = (to_jsonb(OLD) - 'resolvedByUserId') THEN
    RETURN NEW;
  END IF;
  IF OLD."state" = 'OPEN' AND NEW."state" = 'RESOLVED' AND (to_jsonb(NEW) - resolving) = (to_jsonb(OLD) - resolving) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A guardian authority conflict is not rewritten; resolve it once.' USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "GuardianAuthorityConflict_guard" BEFORE INSERT OR UPDATE OR DELETE ON "GuardianAuthorityConflict" FOR EACH ROW EXECUTE FUNCTION "GuardianAuthorityConflict_guard"();
