-- CreateEnum
CREATE TYPE "MemberHonorStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateTable
CREATE TABLE "MemberHonorEntry" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "personId" TEXT NOT NULL,
    "honorId" TEXT NOT NULL,
    "status" "MemberHonorStatus" NOT NULL,
    "completionDate" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "organizationId" TEXT NOT NULL,
    "recordedByAccountId" TEXT,
    "recordedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberHonorEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MemberHonorEntry_personId_honorId_seq_idx" ON "MemberHonorEntry"("personId", "honorId", "seq");

-- CreateIndex
CREATE INDEX "MemberHonorEntry_organizationId_createdAt_idx" ON "MemberHonorEntry"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "MemberHonorEntry_honorId_idx" ON "MemberHonorEntry"("honorId");

-- AddForeignKey
ALTER TABLE "MemberHonorEntry" ADD CONSTRAINT "MemberHonorEntry_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberHonorEntry" ADD CONSTRAINT "MemberHonorEntry_honorId_fkey" FOREIGN KEY ("honorId") REFERENCES "Honor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberHonorEntry" ADD CONSTRAINT "MemberHonorEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberHonorEntry" ADD CONSTRAINT "MemberHonorEntry_recordedByAccountId_fkey" FOREIGN KEY ("recordedByAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberHonorEntry" ADD CONSTRAINT "MemberHonorEntry_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
