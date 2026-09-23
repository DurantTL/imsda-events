-- CreateEnum
CREATE TYPE "ClubRosterAttendeeType" AS ENUM ('YOUTH', 'STAFF', 'ADULT', 'UNDERAGE');

-- CreateEnum
CREATE TYPE "ClubRosterGender" AS ENUM ('FEMALE', 'MALE');

-- CreateEnum
CREATE TYPE "ClubRosterStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'REMOVED');

-- CreateEnum
CREATE TYPE "ClubRosterSource" AS ENUM ('DIRECTOR', 'REGISTRATION');

-- AlterTable
ALTER TABLE "AttendeeSession" ADD COLUMN     "secondFactorVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ClubRosterMember" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clubYear" TEXT NOT NULL,
    "personId" TEXT,
    "attendeeType" "ClubRosterAttendeeType" NOT NULL,
    "role" TEXT NOT NULL DEFAULT '',
    "gender" "ClubRosterGender",
    "sealedBirthDate" TEXT,
    "status" "ClubRosterStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" "ClubRosterSource" NOT NULL,
    "sourceRegistrationId" TEXT,
    "createdByAccountId" TEXT,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubRosterMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClubRosterMember_organizationId_clubYear_status_idx" ON "ClubRosterMember"("organizationId", "clubYear", "status");

-- CreateIndex
CREATE INDEX "ClubRosterMember_personId_idx" ON "ClubRosterMember"("personId");

-- CreateIndex
CREATE UNIQUE INDEX "ClubRosterMember_organizationId_clubYear_personId_key" ON "ClubRosterMember"("organizationId", "clubYear", "personId");

-- AddForeignKey
ALTER TABLE "ClubRosterMember" ADD CONSTRAINT "ClubRosterMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubRosterMember" ADD CONSTRAINT "ClubRosterMember_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubRosterMember" ADD CONSTRAINT "ClubRosterMember_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Only the club decides who is on its roster; a REMOVED row keeps no birth date
-- and no person link.
ALTER TABLE "ClubRosterMember"
  ADD CONSTRAINT "ClubRosterMember_removed_is_erased" CHECK (
    "status" <> 'REMOVED'
    OR ("sealedBirthDate" IS NULL AND "personId" IS NULL AND "removedAt" IS NOT NULL)
  );
