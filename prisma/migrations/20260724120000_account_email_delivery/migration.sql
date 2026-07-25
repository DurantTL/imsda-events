-- Account email — activation and password reset — belongs to a person, not to
-- an event, and has to be deliverable before any event exists. The outbox is
-- already the delivery path with backoff, attempt history, and provider events;
-- the only thing stopping it carrying account email was that every row had to
-- name an event.
ALTER TYPE "MessageTemplateKey" ADD VALUE 'ACCOUNT_ACTIVATION';
ALTER TYPE "MessageTemplateKey" ADD VALUE 'ACCOUNT_PASSWORD_RESET';
ALTER TYPE "MessageRecipientKind" ADD VALUE 'ACCOUNT';

ALTER TABLE "MessageOutbox" ALTER COLUMN "eventId" DROP NOT NULL;

-- The delivery step mints the one-time link from this user, so no raw
-- activation or reset token is ever written to the outbox body.
ALTER TABLE "MessageOutbox" ADD COLUMN "accountUserId" TEXT;

ALTER TABLE "MessageOutbox"
  ADD CONSTRAINT "MessageOutbox_accountUserId_fkey"
  FOREIGN KEY ("accountUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "MessageOutbox_accountUserId_createdAt_idx"
  ON "MessageOutbox"("accountUserId", "createdAt");
