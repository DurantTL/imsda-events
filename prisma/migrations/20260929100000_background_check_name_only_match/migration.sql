-- AlterEnum
-- Additive (#598): a match made on the name alone, when the row's site didn't
-- match but the name is the only one on the list and among the candidates.
ALTER TYPE "BackgroundCheckMatchSource" ADD VALUE 'NAME_ONLY';
