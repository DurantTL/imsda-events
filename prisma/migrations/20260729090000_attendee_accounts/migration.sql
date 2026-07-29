-- Attendee accounts (ADR 0003).
--
-- A registrant has had no identity: a registration is reached through a private
-- link carried in an email, which works until someone needs to be recognised
-- rather than merely let in. These tables give a registrant one.
--
-- They are deliberately parallel to the staff tables rather than shared with
-- them. Every permission in this schema is granted by an EventMembership
-- pointing at a "User", and nothing here can reach one — so the population
-- flowing through the checks that guard roster export and sensitive data is
-- unchanged by this migration.
--
-- The MFA and step-up tables are created before anything calls them. Enrolment
-- becomes required by what an account touches (medical information, club
-- rosters), and retrofitting a second factor onto accounts that already exist
-- costs a migration, a recovery-code scheme, and a rollout; building the tables
-- now costs nothing.

-- Adding an enum value is separated from the rest by a COMMIT, matching the
-- shirt-size template migration: the value has to be committed before any
-- statement may name it.
ALTER TYPE "MessageTemplateKey" ADD VALUE IF NOT EXISTS 'ATTENDEE_EMAIL_VERIFICATION';

COMMIT;

-- CreateEnum
CREATE TYPE "AttendeeAccountStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE');

-- CreateEnum
CREATE TYPE "AttendeeTokenPurpose" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "AttendeeStepUpPurpose" AS ENUM ('REGISTRATION_EDIT');

-- AlterTable
ALTER TABLE "MessageOutbox" ADD COLUMN     "accountAttendeeId" TEXT;

-- CreateTable
CREATE TABLE "AttendeeAccount" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" "AttendeeAccountStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "emailVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendeeAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendeeCredential" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "passwordUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendeeCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendeeSession" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "userAgentHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendeeSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendeeAccountToken" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "codeHash" TEXT,
    "purpose" "AttendeeTokenPurpose" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendeeAccountToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendeeMfaEnrollment" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "method" "MfaMethod" NOT NULL DEFAULT 'TOTP',
    "status" "MfaStatus" NOT NULL DEFAULT 'PENDING',
    "sealedSecret" TEXT NOT NULL,
    "lastUsedStep" BIGINT,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendeeMfaEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendeeMfaRecoveryCode" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendeeMfaRecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendeeStepUpCode" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "purpose" "AttendeeStepUpPurpose" NOT NULL DEFAULT 'REGISTRATION_EDIT',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendeeStepUpCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AttendeeAccount_email_key" ON "AttendeeAccount"("email");

-- CreateIndex
CREATE INDEX "AttendeeAccount_status_idx" ON "AttendeeAccount"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AttendeeCredential_accountId_key" ON "AttendeeCredential"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "AttendeeSession_tokenHash_key" ON "AttendeeSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AttendeeSession_accountId_expiresAt_idx" ON "AttendeeSession"("accountId", "expiresAt");

-- CreateIndex
CREATE INDEX "AttendeeSession_expiresAt_revokedAt_idx" ON "AttendeeSession"("expiresAt", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AttendeeAccountToken_tokenHash_key" ON "AttendeeAccountToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AttendeeAccountToken_accountId_purpose_usedAt_idx" ON "AttendeeAccountToken"("accountId", "purpose", "usedAt");

-- CreateIndex
CREATE INDEX "AttendeeAccountToken_expiresAt_idx" ON "AttendeeAccountToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AttendeeMfaEnrollment_accountId_key" ON "AttendeeMfaEnrollment"("accountId");

-- CreateIndex
CREATE INDEX "AttendeeMfaEnrollment_status_idx" ON "AttendeeMfaEnrollment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AttendeeMfaRecoveryCode_codeHash_key" ON "AttendeeMfaRecoveryCode"("codeHash");

-- CreateIndex
CREATE INDEX "AttendeeMfaRecoveryCode_enrollmentId_usedAt_idx" ON "AttendeeMfaRecoveryCode"("enrollmentId", "usedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AttendeeStepUpCode_codeHash_key" ON "AttendeeStepUpCode"("codeHash");

-- CreateIndex
CREATE INDEX "AttendeeStepUpCode_accountId_purpose_consumedAt_idx" ON "AttendeeStepUpCode"("accountId", "purpose", "consumedAt");

-- CreateIndex
CREATE INDEX "AttendeeStepUpCode_expiresAt_idx" ON "AttendeeStepUpCode"("expiresAt");

-- CreateIndex
CREATE INDEX "MessageOutbox_accountAttendeeId_createdAt_idx" ON "MessageOutbox"("accountAttendeeId", "createdAt");

-- AddForeignKey
ALTER TABLE "AttendeeCredential" ADD CONSTRAINT "AttendeeCredential_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AttendeeAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendeeSession" ADD CONSTRAINT "AttendeeSession_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AttendeeAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendeeAccountToken" ADD CONSTRAINT "AttendeeAccountToken_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AttendeeAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendeeMfaEnrollment" ADD CONSTRAINT "AttendeeMfaEnrollment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AttendeeAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendeeMfaRecoveryCode" ADD CONSTRAINT "AttendeeMfaRecoveryCode_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "AttendeeMfaEnrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendeeStepUpCode" ADD CONSTRAINT "AttendeeStepUpCode_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AttendeeAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageOutbox" ADD CONSTRAINT "MessageOutbox_accountAttendeeId_fkey" FOREIGN KEY ("accountAttendeeId") REFERENCES "AttendeeAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

