-- AlterTable
ALTER TABLE "ClubRosterMember" ADD COLUMN     "willingToDrive" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "DriverVerification" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "clearedToTransport" BOOLEAN NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "reviewedByAccountId" TEXT,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriverVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DriverVerification_personId_key" ON "DriverVerification"("personId");

-- CreateIndex
CREATE INDEX "DriverVerification_reviewedByAccountId_idx" ON "DriverVerification"("reviewedByAccountId");

-- CreateIndex
CREATE INDEX "DriverVerification_reviewedByUserId_idx" ON "DriverVerification"("reviewedByUserId");

-- AddForeignKey
ALTER TABLE "DriverVerification" ADD CONSTRAINT "DriverVerification_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverVerification" ADD CONSTRAINT "DriverVerification_reviewedByAccountId_fkey" FOREIGN KEY ("reviewedByAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverVerification" ADD CONSTRAINT "DriverVerification_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
