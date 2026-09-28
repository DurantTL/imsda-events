-- Earned awards (#532): class insignia, event patches, Good Conduct/TLT and
-- Master Award progress join the club order layer (#487) as a third source of
-- "needs" (ClubOrderSourceType AWARD), so they flow through the same order
-- batches, stock, locks, exports and audit as honors (#487) and uniforms (#497).
-- New tables: MemberClassCompletion (the explicit "completed a class" signal
-- that makes an insignia set a suggestion), EventAwardItem (a catalog item
-- staff link to a club event), and the Master Award rules stored as data
-- (MasterAwardRule -> MasterAwardRuleGroup -> MasterAwardRuleGroupHonor).
-- Hand-written; matches `prisma migrate diff` against the schema exactly.
-- The new enum value is not used in this migration (PostgreSQL 12+ allows the
-- ALTER TYPE inside the transaction), the same as the #497 migration.

-- CreateEnum
CREATE TYPE "MasterAwardRuleStatus" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE');

-- AlterEnum
ALTER TYPE "ClubOrderSourceType" ADD VALUE 'AWARD';

-- CreateTable
CREATE TABLE "MemberClassCompletion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "classLevel" "ClubClassLevel" NOT NULL,
    "completedOn" TEXT NOT NULL,
    "insigniaDismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberClassCompletion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventAwardItem" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventAwardItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MasterAwardRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "itemId" TEXT,
    "status" "MasterAwardRuleStatus" NOT NULL DEFAULT 'DRAFT',
    "needsManualCheck" BOOLEAN NOT NULL DEFAULT false,
    "reviewNote" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MasterAwardRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MasterAwardRuleGroup" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "minimum" INTEGER NOT NULL,
    "unmatchedHonorNames" TEXT[],

    CONSTRAINT "MasterAwardRuleGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MasterAwardRuleGroupHonor" (
    "groupId" TEXT NOT NULL,
    "honorId" TEXT NOT NULL,

    CONSTRAINT "MasterAwardRuleGroupHonor_pkey" PRIMARY KEY ("groupId","honorId")
);

-- CreateIndex
CREATE INDEX "MemberClassCompletion_personId_idx" ON "MemberClassCompletion"("personId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberClassCompletion_organizationId_personId_classLevel_key" ON "MemberClassCompletion"("organizationId", "personId", "classLevel");

-- CreateIndex
CREATE INDEX "EventAwardItem_itemId_idx" ON "EventAwardItem"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "EventAwardItem_eventId_itemId_key" ON "EventAwardItem"("eventId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "MasterAwardRule_normalizedName_key" ON "MasterAwardRule"("normalizedName");

-- CreateIndex
CREATE INDEX "MasterAwardRule_status_idx" ON "MasterAwardRule"("status");

-- CreateIndex
CREATE UNIQUE INDEX "MasterAwardRuleGroup_ruleId_position_key" ON "MasterAwardRuleGroup"("ruleId", "position");

-- CreateIndex
CREATE INDEX "MasterAwardRuleGroupHonor_honorId_idx" ON "MasterAwardRuleGroupHonor"("honorId");

-- AddForeignKey
ALTER TABLE "MemberClassCompletion" ADD CONSTRAINT "MemberClassCompletion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberClassCompletion" ADD CONSTRAINT "MemberClassCompletion_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventAwardItem" ADD CONSTRAINT "EventAwardItem_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventAwardItem" ADD CONSTRAINT "EventAwardItem_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ClubSupplyItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MasterAwardRule" ADD CONSTRAINT "MasterAwardRule_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ClubSupplyItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MasterAwardRuleGroup" ADD CONSTRAINT "MasterAwardRuleGroup_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "MasterAwardRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MasterAwardRuleGroupHonor" ADD CONSTRAINT "MasterAwardRuleGroupHonor_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "MasterAwardRuleGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MasterAwardRuleGroupHonor" ADD CONSTRAINT "MasterAwardRuleGroupHonor_honorId_fkey" FOREIGN KEY ("honorId") REFERENCES "Honor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

