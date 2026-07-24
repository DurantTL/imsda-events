-- An account created by an invitation holds a random, unusable password hash so
-- that no operator ever hands out a credential. Until now that account was
-- indistinguishable in the schema from one whose owner had chosen a password.
CREATE TYPE "UserAccountStatus" AS ENUM (
  'PENDING_ACTIVATION',
  'ACTIVE'
);

-- Activation and password reset are the same one-time, hash-only token with
-- different lifetimes and different wording.
CREATE TYPE "AccountTokenPurpose" AS ENUM (
  'PASSWORD_RESET',
  'ACCOUNT_ACTIVATION'
);

ALTER TABLE "User"
  ADD COLUMN "accountStatus" "UserAccountStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "activatedAt" TIMESTAMP(3);

-- Every account that exists before this migration already has a usable
-- credential, so it is active as of the moment it was created.
UPDATE "User" SET "activatedAt" = "createdAt" WHERE "activatedAt" IS NULL;

ALTER TABLE "PasswordResetToken"
  ADD COLUMN "purpose" "AccountTokenPurpose" NOT NULL DEFAULT 'PASSWORD_RESET';

CREATE INDEX "User_accountStatus_idx" ON "User"("accountStatus");
