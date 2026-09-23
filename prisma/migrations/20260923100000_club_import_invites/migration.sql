-- C4 (#376): club import from the old website's registration form, and
-- conference invites for directors and deputies.

-- CreateEnum
CREATE TYPE "ClubInviteStatus" AS ENUM ('PENDING', 'SENT', 'ACCEPTED', 'CANCELLED');

-- AlterEnum (PostgreSQL 12+ allows this in a transaction; the new values are not used here)
ALTER TYPE "ClubRosterSource" ADD VALUE 'IMPORT';

-- AlterEnum
ALTER TYPE "ExternalSystem" ADD VALUE 'FLUENT_FORMS';

-- AlterEnum
ALTER TYPE "MessageTemplateKey" ADD VALUE 'CLUB_INVITE';

-- AlterTable
ALTER TABLE "ClubRosterMember" ADD COLUMN     "reportedAge" INTEGER;

-- CreateTable
CREATE TABLE "ClubInvite" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "role" "ClubDirectorRole" NOT NULL,
    "status" "ClubInviteStatus" NOT NULL DEFAULT 'PENDING',
    "source" TEXT NOT NULL DEFAULT 'IMPORT',
    "createdByUserId" TEXT,
    "sentAt" TIMESTAMP(3),
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessageId" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "acceptedAccountId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClubInvite_email_status_idx" ON "ClubInvite"("email", "status");

-- CreateIndex
CREATE INDEX "ClubInvite_organizationId_status_idx" ON "ClubInvite"("organizationId", "status");

-- AddForeignKey
ALTER TABLE "ClubInvite" ADD CONSTRAINT "ClubInvite_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubInvite" ADD CONSTRAINT "ClubInvite_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubInvite" ADD CONSTRAINT "ClubInvite_acceptedAccountId_fkey" FOREIGN KEY ("acceptedAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
