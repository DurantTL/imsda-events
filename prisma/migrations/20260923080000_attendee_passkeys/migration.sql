-- Passkeys as an attendee's second step (#62 area): the relying-party ID set
-- by a system administrator, registered passkeys, and one-time challenges.

-- CreateEnum
CREATE TYPE "PasskeyChallengePurpose" AS ENUM ('REGISTER', 'VERIFY');

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN     "passkeyRpId" TEXT;

-- CreateTable
CREATE TABLE "AttendeePasskey" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deviceType" TEXT NOT NULL,
    "backedUp" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "AttendeePasskey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendeePasskeyChallenge" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "purpose" "PasskeyChallengePurpose" NOT NULL,
    "challenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "AttendeePasskeyChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AttendeePasskey_credentialId_key" ON "AttendeePasskey"("credentialId");

-- CreateIndex
CREATE INDEX "AttendeePasskey_accountId_revokedAt_idx" ON "AttendeePasskey"("accountId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AttendeePasskeyChallenge_challenge_key" ON "AttendeePasskeyChallenge"("challenge");

-- CreateIndex
CREATE INDEX "AttendeePasskeyChallenge_sessionId_purpose_idx" ON "AttendeePasskeyChallenge"("sessionId", "purpose");

-- AddForeignKey
ALTER TABLE "AttendeePasskey" ADD CONSTRAINT "AttendeePasskey_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AttendeeAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendeePasskeyChallenge" ADD CONSTRAINT "AttendeePasskeyChallenge_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AttendeeSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
