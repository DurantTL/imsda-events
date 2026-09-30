-- Editable event info cards (#652). Additive only: three new section kinds,
-- two new enums, and three new columns on "EventContentSection" that default
-- so every existing row keeps meaning what it meant (public page only, no
-- tone, no items). No data is moved.

-- AlterEnum (PostgreSQL 12+ allows this in a transaction; the new values are not used here)
ALTER TYPE "EventContentSectionKind" ADD VALUE 'NOTICE';
ALTER TYPE "EventContentSectionKind" ADD VALUE 'STEPS';
ALTER TYPE "EventContentSectionKind" ADD VALUE 'CHECKLIST';

-- CreateEnum
CREATE TYPE "EventContentTone" AS ENUM ('INFO', 'DEADLINE', 'REQUIREMENT', 'SUCCESS', 'HELP');

-- CreateEnum
CREATE TYPE "EventContentPlacement" AS ENUM ('PUBLIC_PAGE', 'REGISTRATION_FORM', 'BOTH');

-- AlterTable
ALTER TABLE "EventContentSection"
  ADD COLUMN "tone" "EventContentTone",
  ADD COLUMN "placement" "EventContentPlacement" NOT NULL DEFAULT 'PUBLIC_PAGE',
  ADD COLUMN "items" JSONB NOT NULL DEFAULT '[]';
