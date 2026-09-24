-- Club team invites (#425): a director or deputy adding a Registrar or
-- Reporter with no account yet now creates and sends an invite, reusing the
-- club import's invite table. Adds who created it (a club leader's own
-- account, distinct from staff's createdByUserId) and an expiry.

-- AlterEnum
ALTER TYPE "MessageTemplateKey" ADD VALUE 'CLUB_TEAM_ROLE_NOTIFICATION';

-- AlterTable
ALTER TABLE "ClubInvite" ADD COLUMN     "createdByAccountId" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "ClubInvite" ADD CONSTRAINT "ClubInvite_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
