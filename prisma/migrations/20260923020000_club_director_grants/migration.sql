-- CreateEnum
CREATE TYPE "ClubDirectorRole" AS ENUM ('DIRECTOR', 'DEPUTY');

-- CreateTable
CREATE TABLE "ClubDirectorGrant" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "attendeeAccountId" TEXT NOT NULL,
    "role" "ClubDirectorRole" NOT NULL DEFAULT 'DIRECTOR',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "grantedByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "revokeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubDirectorGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClubDirectorGrant_attendeeAccountId_revokedAt_idx" ON "ClubDirectorGrant"("attendeeAccountId", "revokedAt");

-- CreateIndex
CREATE INDEX "ClubDirectorGrant_organizationId_revokedAt_idx" ON "ClubDirectorGrant"("organizationId", "revokedAt");

-- AddForeignKey
ALTER TABLE "ClubDirectorGrant" ADD CONSTRAINT "ClubDirectorGrant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubDirectorGrant" ADD CONSTRAINT "ClubDirectorGrant_attendeeAccountId_fkey" FOREIGN KEY ("attendeeAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubDirectorGrant" ADD CONSTRAINT "ClubDirectorGrant_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubDirectorGrant" ADD CONSTRAINT "ClubDirectorGrant_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
