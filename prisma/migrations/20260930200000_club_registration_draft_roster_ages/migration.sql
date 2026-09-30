-- Ages typed in for roster people with no birth date (#639). Additive: existing drafts get an empty object.
ALTER TABLE "ClubRegistrationDraft" ADD COLUMN "rosterAges" JSONB NOT NULL DEFAULT '{}';
-- Members whose typed-in age the director chose not to save back to the roster (#639).
ALTER TABLE "ClubRegistrationDraft" ADD COLUMN "rosterAgeSaveOff" JSONB NOT NULL DEFAULT '[]';
