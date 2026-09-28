-- Q1 (#481): explicit event audience, independent of billing mode. Every
-- existing row defaults to GENERAL; the data backfill that reclassifies
-- deferred-organization/church-billed events as CLUB is a separate,
-- reviewable step (`npm run event-audience:backfill`), not part of this
-- schema migration.

-- CreateEnum
CREATE TYPE "EventAudience" AS ENUM ('GENERAL', 'CLUB');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN "audience" "EventAudience" NOT NULL DEFAULT 'GENERAL';
