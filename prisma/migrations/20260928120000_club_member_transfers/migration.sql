-- CreateEnum
CREATE TYPE "MemberTransferResolution" AS ENUM ('SENDING_CLUB_ACKNOWLEDGED', 'STAFF_FINISHED', 'STAFF_OVERRIDDEN');

-- CreateEnum
CREATE TYPE "MemberTransferEventType" AS ENUM ('INITIATED', 'ACKNOWLEDGED', 'STAFF_FINISHED', 'STAFF_OVERRIDDEN', 'REGISTRATION_REPOINTED', 'NOTIFIED');

-- CreateEnum
CREATE TYPE "MemberTransferStatus" AS ENUM ('PENDING', 'COMPLETED');

-- AlterEnum
ALTER TYPE "MessageTemplateKey" ADD VALUE 'MEMBER_TRANSFER_STARTED';
ALTER TYPE "MessageTemplateKey" ADD VALUE 'MEMBER_TRANSFER_COMPLETED';

-- AlterEnum
ALTER TYPE "ClubRosterSource" ADD VALUE 'TRANSFER';

-- CreateTable
CREATE TABLE "MemberTransfer" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "clubYear" TEXT NOT NULL,
    "fromOrganizationId" TEXT NOT NULL,
    "toOrganizationId" TEXT NOT NULL,
    "fromRosterMemberId" TEXT NOT NULL,
    "toRosterMemberId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "MemberTransferStatus" NOT NULL DEFAULT 'PENDING',
    "resolution" "MemberTransferResolution",
    "initiatedByAccountId" TEXT,
    "initiatedByUserId" TEXT,
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgeDueAt" TIMESTAMP(3) NOT NULL,
    "resolvedByAccountId" TEXT,
    "resolvedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "staffNote" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberTransferEvent" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "type" "MemberTransferEventType" NOT NULL,
    "actorAccountId" TEXT,
    "actorUserId" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberTransferEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MemberTransfer_fromRosterMemberId_key" ON "MemberTransfer"("fromRosterMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberTransfer_toRosterMemberId_key" ON "MemberTransfer"("toRosterMemberId");

-- CreateIndex
CREATE INDEX "MemberTransfer_personId_idx" ON "MemberTransfer"("personId");

-- CreateIndex
CREATE INDEX "MemberTransfer_toOrganizationId_createdAt_idx" ON "MemberTransfer"("toOrganizationId", "createdAt");

-- CreateIndex
CREATE INDEX "MemberTransfer_fromOrganizationId_createdAt_idx" ON "MemberTransfer"("fromOrganizationId", "createdAt");

-- CreateIndex
CREATE INDEX "MemberTransfer_status_acknowledgeDueAt_idx" ON "MemberTransfer"("status", "acknowledgeDueAt");

-- CreateIndex
CREATE INDEX "MemberTransferEvent_transferId_createdAt_idx" ON "MemberTransferEvent"("transferId", "createdAt");

-- AddForeignKey
ALTER TABLE "MemberTransfer" ADD CONSTRAINT "MemberTransfer_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberTransfer" ADD CONSTRAINT "MemberTransfer_fromOrganizationId_fkey" FOREIGN KEY ("fromOrganizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberTransfer" ADD CONSTRAINT "MemberTransfer_toOrganizationId_fkey" FOREIGN KEY ("toOrganizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberTransfer" ADD CONSTRAINT "MemberTransfer_fromRosterMemberId_fkey" FOREIGN KEY ("fromRosterMemberId") REFERENCES "ClubRosterMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberTransfer" ADD CONSTRAINT "MemberTransfer_toRosterMemberId_fkey" FOREIGN KEY ("toRosterMemberId") REFERENCES "ClubRosterMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberTransfer" ADD CONSTRAINT "MemberTransfer_initiatedByAccountId_fkey" FOREIGN KEY ("initiatedByAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberTransfer" ADD CONSTRAINT "MemberTransfer_initiatedByUserId_fkey" FOREIGN KEY ("initiatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberTransfer" ADD CONSTRAINT "MemberTransfer_resolvedByAccountId_fkey" FOREIGN KEY ("resolvedByAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberTransfer" ADD CONSTRAINT "MemberTransfer_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberTransferEvent" ADD CONSTRAINT "MemberTransferEvent_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "MemberTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberTransferEvent" ADD CONSTRAINT "MemberTransferEvent_actorAccountId_fkey" FOREIGN KEY ("actorAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberTransferEvent" ADD CONSTRAINT "MemberTransferEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
