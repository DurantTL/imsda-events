-- Second factor for the accounts that can export a full attendee roster.
-- Every authorization check in this system is downstream of a single password
-- until this exists.
CREATE TYPE "MfaMethod" AS ENUM ('TOTP');
CREATE TYPE "MfaStatus" AS ENUM ('PENDING', 'ACTIVE');
CREATE TYPE "MfaChallengeKind" AS ENUM ('SIGN_IN');

-- The TOTP secret is the one credential here that cannot be a digest, because
-- verifying a code requires the secret itself. It is sealed with AES-256-GCM
-- under a key derived from SECRET_ENCRYPTION_KEY, so a database dump alone
-- yields nothing usable.
CREATE TABLE "UserMfaEnrollment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
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

    CONSTRAINT "UserMfaEnrollment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserMfaEnrollment_userId_key" ON "UserMfaEnrollment"("userId");
CREATE INDEX "UserMfaEnrollment_status_idx" ON "UserMfaEnrollment"("status");

CREATE TABLE "MfaRecoveryCode" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MfaRecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MfaRecoveryCode_codeHash_key" ON "MfaRecoveryCode"("codeHash");
CREATE INDEX "MfaRecoveryCode_enrollmentId_usedAt_idx" ON "MfaRecoveryCode"("enrollmentId", "usedAt");

-- The state between a correct password and a completed second factor. Kept out
-- of UserSession so a challenge can never be mistaken for a signed-in session.
CREATE TABLE "MfaChallenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" "MfaChallengeKind" NOT NULL DEFAULT 'SIGN_IN',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MfaChallenge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MfaChallenge_tokenHash_key" ON "MfaChallenge"("tokenHash");
CREATE INDEX "MfaChallenge_userId_expiresAt_idx" ON "MfaChallenge"("userId", "expiresAt");
CREATE INDEX "MfaChallenge_expiresAt_idx" ON "MfaChallenge"("expiresAt");

ALTER TABLE "UserMfaEnrollment"
  ADD CONSTRAINT "UserMfaEnrollment_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MfaRecoveryCode"
  ADD CONSTRAINT "MfaRecoveryCode_enrollmentId_fkey"
  FOREIGN KEY ("enrollmentId") REFERENCES "UserMfaEnrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MfaChallenge"
  ADD CONSTRAINT "MfaChallenge_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
