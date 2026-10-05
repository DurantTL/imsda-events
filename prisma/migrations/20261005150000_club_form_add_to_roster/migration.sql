-- "Add to roster" from submitted club forms (#721). Additive only: one enum, one nullable template column, and three
-- nullable submission columns with an index and a foreign key that clears itself when the roster member is erased.

CREATE TYPE "ClubFormRosterAction" AS ENUM ('ADDED', 'LINKED');

ALTER TABLE "ClubFormTemplate" ADD COLUMN "rosterMapping" JSONB;

ALTER TABLE "ClubFormSubmission"
  ADD COLUMN "rosterAction" "ClubFormRosterAction",
  ADD COLUMN "rosterActionMemberId" TEXT,
  ADD COLUMN "rosterActionAt" TIMESTAMP(3);

CREATE INDEX "ClubFormSubmission_rosterActionMemberId_idx" ON "ClubFormSubmission"("rosterActionMemberId");

ALTER TABLE "ClubFormSubmission"
  ADD CONSTRAINT "ClubFormSubmission_rosterActionMemberId_fkey"
  FOREIGN KEY ("rosterActionMemberId") REFERENCES "ClubRosterMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
