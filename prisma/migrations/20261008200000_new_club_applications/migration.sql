-- New club applications (#817). Additive only: three enums, two tables, one nullable column on
-- PlatformSettings (the notification address) and three new message template keys. Nothing existing is
-- changed or deleted. Matches `prisma migrate diff` against the schema exactly.

-- CreateEnum
CREATE TYPE "NewClubApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED');


-- CreateEnum
CREATE TYPE "NewClubApplicationType" AS ENUM ('PATHFINDER', 'ADVENTURER');


-- CreateEnum
CREATE TYPE "NewClubApplicationSource" AS ENUM ('PUBLIC', 'INVITE');

-- AlterEnum

ALTER TYPE "MessageTemplateKey" ADD VALUE 'NEW_CLUB_APPLICATION_SUBMITTED';
ALTER TYPE "MessageTemplateKey" ADD VALUE 'NEW_CLUB_APPLICATION_DECLINED';
ALTER TYPE "MessageTemplateKey" ADD VALUE 'NEW_CLUB_APPLICATION_INVITE';

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN     "newClubApplicationEmail" TEXT;

-- CreateTable
CREATE TABLE "NewClubApplication" (
    "id" TEXT NOT NULL,
    "status" "NewClubApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "source" "NewClubApplicationSource" NOT NULL,
    "clubName" TEXT NOT NULL,
    "clubType" "NewClubApplicationType" NOT NULL,
    "sponsoringChurchId" TEXT,
    "sponsoringChurchOther" TEXT,
    "pastorName" TEXT NOT NULL,
    "directorName" TEXT NOT NULL,
    "directorAddress" TEXT NOT NULL,
    "directorEmail" TEXT NOT NULL,
    "directorHomePhone" TEXT,
    "directorWorkPhone" TEXT,
    "philosophyAgreed" BOOLEAN NOT NULL,
    "pastorSignature" TEXT NOT NULL,
    "headElderSignature" TEXT NOT NULL,
    "clerkSignature" TEXT NOT NULL,
    "directorSignature" TEXT NOT NULL,
    "otherBoardMembers" TEXT[],
    "applicationDate" DATE NOT NULL,
    "note" TEXT,
    "attachmentName" TEXT,
    "attachmentContentType" TEXT,
    "attachmentByteSize" INTEGER,
    "attachmentChecksum" TEXT,
    "attachmentStorageKey" TEXT,
    "inviteId" TEXT,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "createdOrganizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NewClubApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewClubApplicationInvite" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "tokenHash" TEXT,
    "messageId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NewClubApplicationInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NewClubApplication_attachmentStorageKey_key" ON "NewClubApplication"("attachmentStorageKey");

-- CreateIndex
CREATE UNIQUE INDEX "NewClubApplication_inviteId_key" ON "NewClubApplication"("inviteId");

-- CreateIndex
CREATE UNIQUE INDEX "NewClubApplication_createdOrganizationId_key" ON "NewClubApplication"("createdOrganizationId");

-- CreateIndex
CREATE INDEX "NewClubApplication_status_createdAt_idx" ON "NewClubApplication"("status", "createdAt");

-- CreateIndex
CREATE INDEX "NewClubApplication_directorEmail_idx" ON "NewClubApplication"("directorEmail");

-- CreateIndex
CREATE INDEX "NewClubApplication_sponsoringChurchId_idx" ON "NewClubApplication"("sponsoringChurchId");

-- CreateIndex
CREATE UNIQUE INDEX "NewClubApplicationInvite_tokenHash_key" ON "NewClubApplicationInvite"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "NewClubApplicationInvite_messageId_key" ON "NewClubApplicationInvite"("messageId");

-- CreateIndex
CREATE INDEX "NewClubApplicationInvite_email_idx" ON "NewClubApplicationInvite"("email");

-- AddForeignKey
ALTER TABLE "NewClubApplication" ADD CONSTRAINT "NewClubApplication_sponsoringChurchId_fkey" FOREIGN KEY ("sponsoringChurchId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewClubApplication" ADD CONSTRAINT "NewClubApplication_createdOrganizationId_fkey" FOREIGN KEY ("createdOrganizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewClubApplication" ADD CONSTRAINT "NewClubApplication_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewClubApplication" ADD CONSTRAINT "NewClubApplication_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "NewClubApplicationInvite"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewClubApplicationInvite" ADD CONSTRAINT "NewClubApplicationInvite_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

