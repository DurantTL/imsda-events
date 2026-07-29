-- Google sign-in for attendee accounts.
--
-- A registrant may now hold a sign-in method owned by Google instead of, or as
-- well as, a password. Two consequences are recorded here.
--
-- "AttendeeIdentity" is keyed on the provider's subject, not on the address.
-- A Google account can change its email, and matching on the address would let
-- that change move an attendee account onto an address it never proved control
-- of. The address is stored for display and support only.
--
-- "disabledAt" moves to the account. It previously lived only on
-- "AttendeeCredential", which works while every account has a password — but an
-- account that only ever used Google has no credential row for a method-level
-- flag to live on. The credential flag stays, and now means what it says:
-- this password is retired. The account flag shuts the person out entirely.
CREATE TYPE "AttendeeIdentityProvider" AS ENUM ('GOOGLE');

ALTER TABLE "AttendeeAccount" ADD COLUMN "disabledAt" TIMESTAMP(3);

CREATE TABLE "AttendeeIdentity" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "provider" "AttendeeIdentityProvider" NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "AttendeeIdentity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AttendeeIdentity_accountId_idx" ON "AttendeeIdentity"("accountId");

-- One Google account reaches one attendee account, and no more.
CREATE UNIQUE INDEX "AttendeeIdentity_provider_subject_key" ON "AttendeeIdentity"("provider", "subject");

-- And one attendee account holds at most one identity per provider, so
-- "sign in with Google" is never ambiguous about which identity it spent.
CREATE UNIQUE INDEX "AttendeeIdentity_accountId_provider_key" ON "AttendeeIdentity"("accountId", "provider");

ALTER TABLE "AttendeeIdentity" ADD CONSTRAINT "AttendeeIdentity_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AttendeeAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
