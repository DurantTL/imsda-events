-- C2 (#374): passkey sign-in challenges have no session yet.

-- AlterEnum (PostgreSQL 12+ allows this in a transaction; the new value is not used here)
ALTER TYPE "PasskeyChallengePurpose" ADD VALUE 'SIGN_IN';

-- AlterTable
ALTER TABLE "AttendeePasskeyChallenge" ALTER COLUMN "sessionId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "AttendeePasskeyChallenge_purpose_expiresAt_idx" ON "AttendeePasskeyChallenge"("purpose", "expiresAt");
