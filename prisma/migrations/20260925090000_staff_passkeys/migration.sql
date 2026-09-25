-- Staff passkeys (#429): a credential table and challenge table separate
-- from AttendeePasskey / AttendeePasskeyChallenge, mirroring their shape.
-- Reuses the existing PasskeyChallengePurpose enum.

-- CreateTable
CREATE TABLE "UserPasskey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
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

CONSTRAINT "UserPasskey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPasskeyChallenge" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT,
    "purpose" "PasskeyChallengePurpose" NOT NULL,
    "challenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "UserPasskeyChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserPasskey_credentialId_key" ON "UserPasskey"("credentialId");

-- CreateIndex
CREATE INDEX "UserPasskey_userId_revokedAt_idx" ON "UserPasskey"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserPasskeyChallenge_challenge_key" ON "UserPasskeyChallenge"("challenge");

-- CreateIndex
CREATE INDEX "UserPasskeyChallenge_sessionId_purpose_idx" ON "UserPasskeyChallenge"("sessionId", "purpose");

-- CreateIndex
CREATE INDEX "UserPasskeyChallenge_purpose_expiresAt_idx" ON "UserPasskeyChallenge"("purpose", "expiresAt");

-- AddForeignKey
ALTER TABLE "UserPasskey" ADD CONSTRAINT "UserPasskey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPasskeyChallenge" ADD CONSTRAINT "UserPasskeyChallenge_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "UserSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
