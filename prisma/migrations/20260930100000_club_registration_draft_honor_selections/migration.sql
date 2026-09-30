-- Honors picked while registering a club (#618). Additive: existing drafts get an empty object.
ALTER TABLE "ClubRegistrationDraft" ADD COLUMN "honorSelections" JSONB NOT NULL DEFAULT '{}';
