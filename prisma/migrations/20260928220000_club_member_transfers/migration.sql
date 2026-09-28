-- Club member transfers (#489): a request from the receiving club, matched on
-- exact names inside the named club, completed by the sending club or staff,
-- and a staff approval list for each open club registration the member holds.
-- One open matched transfer per person (pendingPersonId) and one open request
-- per club and typed name (requestKey) are enforced by unique indexes.

-- CreateEnum
CREATE TYPE "MemberTransferResolution" AS ENUM ('SENDING_CLUB_ACCEPTED', 'STAFF_FINISHED', 'STAFF_OVERRIDDEN');

-- CreateEnum
CREATE TYPE "MemberTransferEventType" AS ENUM ('REQUESTED', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'STAFF_FINISHED', 'STAFF_OVERRIDDEN', 'REGISTRATION_MOVE_QUEUED', 'REGISTRATION_MOVE_APPROVED', 'REGISTRATION_MOVE_SKIPPED', 'NOTIFIED');

-- CreateEnum
CREATE TYPE "MemberTransferStatus" AS ENUM ('PENDING', 'UNMATCHED', 'DECLINED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MemberTransferStaffReason" AS ENUM ('NO_MATCH', 'AMBIGUOUS_MATCH', 'ALREADY_PENDING', 'SAME_DIRECTOR');

-- CreateEnum
CREATE TYPE "MemberTransferRegistrationMoveStatus" AS ENUM ('PENDING', 'APPROVED', 'SKIPPED');

-- AlterEnum
ALTER TYPE "ClubRosterSource" ADD VALUE 'TRANSFER';

-- AlterEnum
ALTER TYPE "MessageTemplateKey" ADD VALUE 'MEMBER_TRANSFER_STARTED';
ALTER TYPE "MessageTemplateKey" ADD VALUE 'MEMBER_TRANSFER_COMPLETED';

-- CreateTable
CREATE TABLE "MemberTransfer" (
    "id" TEXT NOT NULL,
    "personId" TEXT,
    "pendingPersonId" TEXT,
    "requestKey" TEXT,
    "clubYear" TEXT NOT NULL,
    "fromOrganizationId" TEXT NOT NULL,
    "toOrganizationId" TEXT NOT NULL,
    "fromRosterMemberId" TEXT,
    "toRosterMemberId" TEXT,
    "requestedFirstName" TEXT NOT NULL,
    "requestedLastName" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "MemberTransferStatus" NOT NULL DEFAULT 'PENDING',
    "staffReason" "MemberTransferStaffReason",
    "sendingClubVisible" BOOLEAN NOT NULL DEFAULT false,
    "resolution" "MemberTransferResolution",
    "initiatedByAccountId" TEXT,
    "initiatedByUserId" TEXT,
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgeDueAt" TIMESTAMP(3) NOT NULL,
    "declinedAt" TIMESTAMP(3),
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

-- CreateTable
CREATE TABLE "MemberTransferRegistrationMove" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "registrationAttendeeId" TEXT,
    "fromRegistrationId" TEXT,
    "toRegistrationId" TEXT,
    "status" "MemberTransferRegistrationMoveStatus" NOT NULL DEFAULT 'PENDING',
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberTransferRegistrationMove_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MemberTransfer_pendingPersonId_key" ON "MemberTransfer"("pendingPersonId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberTransfer_requestKey_key" ON "MemberTransfer"("requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "MemberTransfer_toRosterMemberId_key" ON "MemberTransfer"("toRosterMemberId");

-- CreateIndex
CREATE INDEX "MemberTransfer_personId_idx" ON "MemberTransfer"("personId");

-- CreateIndex
CREATE INDEX "MemberTransfer_fromRosterMemberId_idx" ON "MemberTransfer"("fromRosterMemberId");

-- CreateIndex
CREATE INDEX "MemberTransfer_toOrganizationId_createdAt_idx" ON "MemberTransfer"("toOrganizationId", "createdAt");

-- CreateIndex
CREATE INDEX "MemberTransfer_fromOrganizationId_createdAt_idx" ON "MemberTransfer"("fromOrganizationId", "createdAt");

-- CreateIndex
CREATE INDEX "MemberTransfer_status_acknowledgeDueAt_idx" ON "MemberTransfer"("status", "acknowledgeDueAt");

-- CreateIndex
CREATE INDEX "MemberTransferEvent_transferId_createdAt_idx" ON "MemberTransferEvent"("transferId", "createdAt");

-- CreateIndex
CREATE INDEX "MemberTransferRegistrationMove_status_createdAt_idx" ON "MemberTransferRegistrationMove"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MemberTransferRegistrationMove_eventId_idx" ON "MemberTransferRegistrationMove"("eventId");

-- CreateIndex
CREATE INDEX "MemberTransferRegistrationMove_registrationAttendeeId_idx" ON "MemberTransferRegistrationMove"("registrationAttendeeId");

-- CreateIndex
CREATE INDEX "MemberTransferRegistrationMove_fromRegistrationId_idx" ON "MemberTransferRegistrationMove"("fromRegistrationId");

-- CreateIndex
CREATE INDEX "MemberTransferRegistrationMove_toRegistrationId_idx" ON "MemberTransferRegistrationMove"("toRegistrationId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberTransferRegistrationMove_transferId_registrationAtten_key" ON "MemberTransferRegistrationMove"("transferId", "registrationAttendeeId");

-- AddForeignKey
ALTER TABLE "MemberTransfer" ADD CONSTRAINT "MemberTransfer_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberTransfer" ADD CONSTRAINT "MemberTransfer_pendingPersonId_fkey" FOREIGN KEY ("pendingPersonId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberTransfer" ADD CONSTRAINT "MemberTransfer_fromOrganizationId_fkey" FOREIGN KEY ("fromOrganizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberTransfer" ADD CONSTRAINT "MemberTransfer_toOrganizationId_fkey" FOREIGN KEY ("toOrganizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberTransfer" ADD CONSTRAINT "MemberTransfer_fromRosterMemberId_fkey" FOREIGN KEY ("fromRosterMemberId") REFERENCES "ClubRosterMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberTransfer" ADD CONSTRAINT "MemberTransfer_toRosterMemberId_fkey" FOREIGN KEY ("toRosterMemberId") REFERENCES "ClubRosterMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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

-- AddForeignKey
ALTER TABLE "MemberTransferRegistrationMove" ADD CONSTRAINT "MemberTransferRegistrationMove_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "MemberTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberTransferRegistrationMove" ADD CONSTRAINT "MemberTransferRegistrationMove_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberTransferRegistrationMove" ADD CONSTRAINT "MemberTransferRegistrationMove_registrationAttendeeId_fkey" FOREIGN KEY ("registrationAttendeeId") REFERENCES "RegistrationAttendee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberTransferRegistrationMove" ADD CONSTRAINT "MemberTransferRegistrationMove_fromRegistrationId_fkey" FOREIGN KEY ("fromRegistrationId") REFERENCES "Registration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberTransferRegistrationMove" ADD CONSTRAINT "MemberTransferRegistrationMove_toRegistrationId_fkey" FOREIGN KEY ("toRegistrationId") REFERENCES "Registration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberTransferRegistrationMove" ADD CONSTRAINT "MemberTransferRegistrationMove_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

