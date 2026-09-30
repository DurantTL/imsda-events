-- Club registration draft reliability (#659): the chosen location is kept in
-- the draft (no foreign key: a removed location is explained on restore), and
-- a revision lets the server refuse a stale save from a second tab, and
-- the last save id tells a retried save that already landed from a conflict.
ALTER TABLE "ClubRegistrationDraft" ADD COLUMN "locationId" TEXT;
ALTER TABLE "ClubRegistrationDraft" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ClubRegistrationDraft" ADD COLUMN "lastSaveId" TEXT;
