-- New club applications (#817), review follow-up. Additive only: one nullable column that records the address a
-- private link was sent to. Existing rows keep NULL.

-- AlterTable
ALTER TABLE "NewClubApplication" ADD COLUMN     "invitedEmail" TEXT;
