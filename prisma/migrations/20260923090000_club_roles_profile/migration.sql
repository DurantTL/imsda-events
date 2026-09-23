-- C3 (#375): Registrar and Reporter club roles, grants given by the club's
-- own director, roster class level, and the club profile.

-- CreateEnum
CREATE TYPE "ClubClassLevel" AS ENUM ('FRIEND', 'COMPANION', 'EXPLORER', 'RANGER', 'VOYAGER', 'GUIDE', 'TLT', 'MASTER_GUIDE');

-- AlterEnum (PostgreSQL 12+ allows this inside a transaction; the new values are not used here)
ALTER TYPE "ClubDirectorRole" ADD VALUE 'REGISTRAR';
ALTER TYPE "ClubDirectorRole" ADD VALUE 'REPORTER';

-- AlterTable
ALTER TABLE "ClubDirectorGrant" ADD COLUMN     "grantedByAccountId" TEXT,
ADD COLUMN     "revokedByAccountId" TEXT;

-- AlterTable
ALTER TABLE "ClubRosterMember" ADD COLUMN     "classLevel" "ClubClassLevel";

-- CreateTable
CREATE TABLE "ClubProfile" (
    "organizationId" TEXT NOT NULL,
    "meetingPlace" TEXT NOT NULL DEFAULT '',
    "meetingSchedule" TEXT NOT NULL DEFAULT '',
    "contactEmail" TEXT NOT NULL DEFAULT '',
    "contactPhone" TEXT NOT NULL DEFAULT '',
    "publicDescription" TEXT NOT NULL DEFAULT '',
    "listPublicly" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubProfile_pkey" PRIMARY KEY ("organizationId")
);

-- AddForeignKey
ALTER TABLE "ClubProfile" ADD CONSTRAINT "ClubProfile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubDirectorGrant" ADD CONSTRAINT "ClubDirectorGrant_grantedByAccountId_fkey" FOREIGN KEY ("grantedByAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubDirectorGrant" ADD CONSTRAINT "ClubDirectorGrant_revokedByAccountId_fkey" FOREIGN KEY ("revokedByAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
