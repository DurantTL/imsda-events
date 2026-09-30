-- Ages typed in for roster people with no birth date (#639). Additive: existing drafts get an empty object.
ALTER TABLE "ClubRegistrationDraft" ADD COLUMN "rosterAges" JSONB NOT NULL DEFAULT '{}';
