-- Q1 (#481): explicit event audience, independent of billing mode. New rows
-- default to GENERAL. Existing club/church-billed events are backfilled to
-- CLUB in this same migration, so deploy (which runs `prisma migrate deploy`
-- from docker-entrypoint.sh) never leaves them without their club features
-- between the schema change and a separate data step. This follows the
-- in-migration backfill precedent of 20260728190000_event_collects_shirt_sizes.
-- `npm run event-audience:backfill` remains only as a read-only verification
-- report, which should find 0 rows after this migration.

-- CreateEnum
CREATE TYPE "EventAudience" AS ENUM ('GENERAL', 'CLUB');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN "audience" "EventAudience" NOT NULL DEFAULT 'GENERAL';

-- Backfill from the rule being retired: "club event" used to mean an event
-- billed to a club or church. Only ever sets CLUB, never GENERAL.
UPDATE "Event" SET "audience" = 'CLUB' WHERE "billingMode" = 'DEFERRED_ORGANIZATION_INVOICE' AND "audience" <> 'CLUB';
