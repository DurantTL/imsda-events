-- Club Forms (#610): forms that are not tied to an event. A club fills one in
-- for a member, or sends a single-use, expiring private link. Each template
-- is off until a system administrator enables it. Additive only: three new
-- tables, three new enums, one new outbox template key. Nothing existing is
-- altered, and no data is moved. Sensitive answers live only in
-- "ClubFormSubmission"."sealedSensitiveAnswers" (AES-256-GCM through
-- lib/secret-box.ts); the plain "answers" column never holds them.

-- CreateEnum
CREATE TYPE "ClubFormSubmissionStatus" AS ENUM ('DRAFT', 'SUBMITTED');

-- CreateEnum
CREATE TYPE "ClubFormEntryChannel" AS ENUM ('ATTENDEE', 'STAFF_ACTING', 'LINK');

-- CreateEnum
CREATE TYPE "ClubFormLinkStatus" AS ENUM ('OPEN', 'USED', 'REVOKED');

-- AlterEnum (PostgreSQL 12+ allows this in a transaction; the new value is not used here)
ALTER TYPE "MessageTemplateKey" ADD VALUE 'CLUB_FORM_LINK';

-- CreateTable
CREATE TABLE "ClubFormTemplate" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "definition" JSONB NOT NULL,
    "sectionNotes" JSONB NOT NULL DEFAULT '{}',
    "sensitiveFieldKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "birthDateFieldKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "staffOnlyFieldKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "printLayout" TEXT NOT NULL DEFAULT 'STANDARD',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabledAt" TIMESTAMP(3),
    "enabledByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubFormTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubFormSubmission" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clubYear" TEXT NOT NULL,
    "rosterMemberId" TEXT,
    "subjectName" TEXT NOT NULL DEFAULT '',
    "status" "ClubFormSubmissionStatus" NOT NULL DEFAULT 'DRAFT',
    "answers" JSONB NOT NULL DEFAULT '{}',
    "sealedSensitiveAnswers" TEXT,
    "hasSensitiveAnswers" BOOLEAN NOT NULL DEFAULT false,
    "templateVersion" INTEGER NOT NULL,
    "enteredVia" "ClubFormEntryChannel" NOT NULL,
    "enteredByAccountId" TEXT,
    "enteredByUserId" TEXT,
    "linkId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubFormSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubFormLink" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clubYear" TEXT NOT NULL,
    "rosterMemberId" TEXT,
    "subjectName" TEXT NOT NULL DEFAULT '',
    "recipientEmail" TEXT NOT NULL,
    "status" "ClubFormLinkStatus" NOT NULL DEFAULT 'OPEN',
    "tokenHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "messageId" TEXT,
    "createdByAccountId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubFormLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClubFormTemplate_key_key" ON "ClubFormTemplate"("key");

-- CreateIndex
CREATE UNIQUE INDEX "ClubFormSubmission_linkId_key" ON "ClubFormSubmission"("linkId");

-- CreateIndex
CREATE INDEX "ClubFormSubmission_organizationId_templateId_status_idx" ON "ClubFormSubmission"("organizationId", "templateId", "status");

-- CreateIndex
CREATE INDEX "ClubFormSubmission_organizationId_clubYear_idx" ON "ClubFormSubmission"("organizationId", "clubYear");

-- CreateIndex
CREATE INDEX "ClubFormSubmission_rosterMemberId_idx" ON "ClubFormSubmission"("rosterMemberId");

-- CreateIndex
CREATE INDEX "ClubFormSubmission_templateId_submittedAt_idx" ON "ClubFormSubmission"("templateId", "submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClubFormLink_tokenHash_key" ON "ClubFormLink"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "ClubFormLink_messageId_key" ON "ClubFormLink"("messageId");

-- CreateIndex
CREATE INDEX "ClubFormLink_organizationId_status_idx" ON "ClubFormLink"("organizationId", "status");

-- CreateIndex
CREATE INDEX "ClubFormLink_templateId_organizationId_idx" ON "ClubFormLink"("templateId", "organizationId");

-- CreateIndex
CREATE INDEX "ClubFormLink_status_expiresAt_idx" ON "ClubFormLink"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "ClubFormTemplate" ADD CONSTRAINT "ClubFormTemplate_enabledByUserId_fkey" FOREIGN KEY ("enabledByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubFormSubmission" ADD CONSTRAINT "ClubFormSubmission_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ClubFormTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubFormSubmission" ADD CONSTRAINT "ClubFormSubmission_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubFormSubmission" ADD CONSTRAINT "ClubFormSubmission_rosterMemberId_fkey" FOREIGN KEY ("rosterMemberId") REFERENCES "ClubRosterMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubFormSubmission" ADD CONSTRAINT "ClubFormSubmission_enteredByAccountId_fkey" FOREIGN KEY ("enteredByAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubFormSubmission" ADD CONSTRAINT "ClubFormSubmission_enteredByUserId_fkey" FOREIGN KEY ("enteredByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubFormSubmission" ADD CONSTRAINT "ClubFormSubmission_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "ClubFormLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubFormLink" ADD CONSTRAINT "ClubFormLink_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ClubFormTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubFormLink" ADD CONSTRAINT "ClubFormLink_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubFormLink" ADD CONSTRAINT "ClubFormLink_rosterMemberId_fkey" FOREIGN KEY ("rosterMemberId") REFERENCES "ClubRosterMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubFormLink" ADD CONSTRAINT "ClubFormLink_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubFormLink" ADD CONSTRAINT "ClubFormLink_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Database-level guards (Prisma does not model CHECK constraints, so the drift
-- check ignores them). A submission's sensitive flag always matches whether
-- sealed answers exist, a submitted form always has its submitted time, and a
-- used link always records when it was used.
ALTER TABLE "ClubFormSubmission" ADD CONSTRAINT "ClubFormSubmission_sensitive_flag_matches_sealed_check"
    CHECK ("hasSensitiveAnswers" = ("sealedSensitiveAnswers" IS NOT NULL));

ALTER TABLE "ClubFormSubmission" ADD CONSTRAINT "ClubFormSubmission_submitted_has_time_check"
    CHECK ("status" <> 'SUBMITTED' OR "submittedAt" IS NOT NULL);

ALTER TABLE "ClubFormLink" ADD CONSTRAINT "ClubFormLink_used_has_time_check"
    CHECK ("status" <> 'USED' OR "usedAt" IS NOT NULL);
