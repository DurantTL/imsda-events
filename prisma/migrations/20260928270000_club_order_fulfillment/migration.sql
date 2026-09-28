-- Club order fulfillment (#487): a reusable order/stock layer keyed on
-- ClubSupplyItem, with completed honors (#486) as the first source of
-- "needs". Uniform ordering (#497) and earned awards/insignia (#532) will add
-- their own ClubOrderSourceType values later without changing this shape.
-- Also links an Honors Weekend class enrollment (#357-#360) to the
-- MemberHonorEntry it wrote back (or the member's existing COMPLETED entry
-- for that honor), so the write-back job is idempotent. Honor needs are keyed
-- on "personId:honorId", so a re-completion or a date correction never makes
-- a second need for the same patch.
-- Hand-written; matches `prisma migrate diff` against the schema exactly.


-- CreateEnum
CREATE TYPE "ClubOrderSourceType" AS ENUM ('HONOR');

-- CreateEnum
CREATE TYPE "ClubOrderNeedStatus" AS ENUM ('NEEDED', 'ORDERED', 'RECEIVED', 'AWARDED');

-- CreateEnum
CREATE TYPE "ClubSupplyOrderBatchStatus" AS ENUM ('ORDERED', 'RECEIVED');

-- CreateTable
CREATE TABLE "ClubOrderNeed" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sourceType" "ClubOrderSourceType" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "itemId" TEXT,
    "sourceLabel" TEXT NOT NULL DEFAULT '',
    "sourceDate" TEXT NOT NULL DEFAULT '',
    "status" "ClubOrderNeedStatus" NOT NULL DEFAULT 'NEEDED',
    "batchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubOrderNeed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubSupplyOrderBatch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" "ClubSupplyOrderBatchStatus" NOT NULL DEFAULT 'ORDERED',
    "createdByAccountId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedAt" TIMESTAMP(3),
    "receivedByAccountId" TEXT,
    "receivedByUserId" TEXT,

    CONSTRAINT "ClubSupplyOrderBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubSupplyOrderLine" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "neededCount" INTEGER NOT NULL,
    "extraCount" INTEGER NOT NULL DEFAULT 0,
    "stockAtOrderTime" INTEGER NOT NULL,
    "quantityOrdered" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubSupplyOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HonorWeekendCompletionLink" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "memberHonorEntryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HonorWeekendCompletionLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClubOrderNeed_organizationId_status_idx" ON "ClubOrderNeed"("organizationId", "status");

-- CreateIndex
CREATE INDEX "ClubOrderNeed_itemId_idx" ON "ClubOrderNeed"("itemId");

-- CreateIndex
CREATE INDEX "ClubOrderNeed_batchId_idx" ON "ClubOrderNeed"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "ClubOrderNeed_sourceType_sourceId_key" ON "ClubOrderNeed"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "ClubSupplyOrderBatch_organizationId_status_idx" ON "ClubSupplyOrderBatch"("organizationId", "status");

-- CreateIndex
CREATE INDEX "ClubSupplyOrderLine_itemId_idx" ON "ClubSupplyOrderLine"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "ClubSupplyOrderLine_batchId_itemId_key" ON "ClubSupplyOrderLine"("batchId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "HonorWeekendCompletionLink_enrollmentId_key" ON "HonorWeekendCompletionLink"("enrollmentId");

-- CreateIndex
CREATE INDEX "HonorWeekendCompletionLink_memberHonorEntryId_idx" ON "HonorWeekendCompletionLink"("memberHonorEntryId");

-- AddForeignKey
ALTER TABLE "ClubOrderNeed" ADD CONSTRAINT "ClubOrderNeed_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubOrderNeed" ADD CONSTRAINT "ClubOrderNeed_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubOrderNeed" ADD CONSTRAINT "ClubOrderNeed_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ClubSupplyItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubOrderNeed" ADD CONSTRAINT "ClubOrderNeed_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ClubSupplyOrderBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubSupplyOrderBatch" ADD CONSTRAINT "ClubSupplyOrderBatch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubSupplyOrderBatch" ADD CONSTRAINT "ClubSupplyOrderBatch_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubSupplyOrderBatch" ADD CONSTRAINT "ClubSupplyOrderBatch_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubSupplyOrderBatch" ADD CONSTRAINT "ClubSupplyOrderBatch_receivedByAccountId_fkey" FOREIGN KEY ("receivedByAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubSupplyOrderBatch" ADD CONSTRAINT "ClubSupplyOrderBatch_receivedByUserId_fkey" FOREIGN KEY ("receivedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubSupplyOrderLine" ADD CONSTRAINT "ClubSupplyOrderLine_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ClubSupplyOrderBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubSupplyOrderLine" ADD CONSTRAINT "ClubSupplyOrderLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ClubSupplyItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HonorWeekendCompletionLink" ADD CONSTRAINT "HonorWeekendCompletionLink_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "HonorEnrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HonorWeekendCompletionLink" ADD CONSTRAINT "HonorWeekendCompletionLink_memberHonorEntryId_fkey" FOREIGN KEY ("memberHonorEntryId") REFERENCES "MemberHonorEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

