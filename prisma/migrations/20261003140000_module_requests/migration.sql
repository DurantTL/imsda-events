-- #741 slice 3: module requests. Additive only: one enum, one table, two new
-- message template keys. Nothing existing is changed or deleted.

-- AlterEnum
ALTER TYPE "MessageTemplateKey" ADD VALUE 'MODULE_REQUEST_SUBMITTED';
ALTER TYPE "MessageTemplateKey" ADD VALUE 'MODULE_REQUEST_DECIDED';

-- CreateEnum
CREATE TYPE "ModuleRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED');

-- CreateTable
CREATE TABLE "ModuleRequest" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "moduleKey" TEXT NOT NULL,
    "requestedByUserId" TEXT,
    "reason" TEXT NOT NULL,
    "status" "ModuleRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModuleRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModuleRequest_eventId_createdAt_idx" ON "ModuleRequest"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "ModuleRequest_status_createdAt_idx" ON "ModuleRequest"("status", "createdAt");

-- At most one pending request per event and module, enforced by the database
-- so two concurrent submissions leave one. Prisma cannot express a partial index.
CREATE UNIQUE INDEX "ModuleRequest_one_pending_per_module" ON "ModuleRequest"("eventId", "moduleKey") WHERE "status" = 'PENDING';

-- AddForeignKey
ALTER TABLE "ModuleRequest" ADD CONSTRAINT "ModuleRequest_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleRequest" ADD CONSTRAINT "ModuleRequest_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleRequest" ADD CONSTRAINT "ModuleRequest_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
