-- Sign-in security policy (#456): lockout emails on the transition into a
-- password or two-step-code lockout, and a configurable office alert address.

-- New enum values cannot be used in the same transaction that adds them, so
-- this closes the implicit transaction the way REGISTRATION_REACTIVATED and
-- WAITLIST_REMOVED did before it.
ALTER TYPE "MessageTemplateKey" ADD VALUE IF NOT EXISTS 'ACCOUNT_LOCKOUT';
ALTER TYPE "MessageTemplateKey" ADD VALUE IF NOT EXISTS 'ATTENDEE_LOCKOUT';

COMMIT;

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN "securityAlertEmail" TEXT;
