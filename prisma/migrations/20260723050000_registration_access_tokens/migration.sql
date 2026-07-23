-- CreateEnum
CREATE TYPE "RegistrationAccessTokenPurpose" AS ENUM ('MANAGE_REGISTRATION');

-- CreateTable
CREATE TABLE "RegistrationAccessToken" (
  "id" TEXT NOT NULL,
  "registrationId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "purpose" "RegistrationAccessTokenPurpose" NOT NULL DEFAULT 'MANAGE_REGISTRATION',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RegistrationAccessToken_pkey" PRIMARY KEY ("id")
);

-- Only a SHA-256 digest is persisted. The raw bearer token exists only in the
-- issuing process long enough to build the private manage URL.
CREATE UNIQUE INDEX "RegistrationAccessToken_tokenHash_key"
ON "RegistrationAccessToken"("tokenHash");

CREATE INDEX "RegistrationAccessToken_registrationId_purpose_revokedAt_expiresAt_idx"
ON "RegistrationAccessToken"("registrationId", "purpose", "revokedAt", "expiresAt");

CREATE INDEX "RegistrationAccessToken_expiresAt_revokedAt_idx"
ON "RegistrationAccessToken"("expiresAt", "revokedAt");

-- AddForeignKey
ALTER TABLE "RegistrationAccessToken"
ADD CONSTRAINT "RegistrationAccessToken_registrationId_fkey"
FOREIGN KEY ("registrationId") REFERENCES "Registration"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
