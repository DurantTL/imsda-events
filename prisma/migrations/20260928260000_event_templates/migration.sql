-- Q1 (#152): a reusable, versioned event template model and its one-time,
-- non-live "apply" (which creates a new draft Event and records provenance).
-- No existing table is touched, so there is nothing to backfill.

-- CreateEnum
CREATE TYPE "EventTemplateStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "EventTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "audience" "EventAudience" NOT NULL DEFAULT 'GENERAL',
    "status" "EventTemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventTemplateVersion" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "status" "EventTemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "payload" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventTemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventTemplateApplication" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "templateVersionId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "payloadSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventTemplateApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventTemplate_status_updatedAt_idx" ON "EventTemplate"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EventTemplateVersion_templateId_versionNumber_key" ON "EventTemplateVersion"("templateId", "versionNumber");

-- CreateIndex
CREATE INDEX "EventTemplateVersion_templateId_status_versionNumber_idx" ON "EventTemplateVersion"("templateId", "status", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "EventTemplateApplication_eventId_key" ON "EventTemplateApplication"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "EventTemplateApplication_requestKey_key" ON "EventTemplateApplication"("requestKey");

-- CreateIndex
CREATE INDEX "EventTemplateApplication_templateId_createdAt_idx" ON "EventTemplateApplication"("templateId", "createdAt");

-- AddForeignKey
ALTER TABLE "EventTemplate" ADD CONSTRAINT "EventTemplate_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventTemplateVersion" ADD CONSTRAINT "EventTemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "EventTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventTemplateVersion" ADD CONSTRAINT "EventTemplateVersion_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventTemplateApplication" ADD CONSTRAINT "EventTemplateApplication_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "EventTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventTemplateApplication" ADD CONSTRAINT "EventTemplateApplication_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "EventTemplateVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventTemplateApplication" ADD CONSTRAINT "EventTemplateApplication_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventTemplateApplication" ADD CONSTRAINT "EventTemplateApplication_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
