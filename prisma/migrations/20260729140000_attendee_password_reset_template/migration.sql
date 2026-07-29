-- Attendee password reset.
--
-- A distinct template key rather than reusing the verification one, because the
-- delivery worker routes on it: each attendee email mints its code against a
-- token of a particular purpose, and one key for both would leave it guessing
-- which of two live tokens a message belonged to.
--
-- Separated from the rest by a COMMIT, matching the shirt-size template
-- migration: an enum value has to be committed before any statement may name it.
ALTER TYPE "MessageTemplateKey" ADD VALUE IF NOT EXISTS 'ATTENDEE_PASSWORD_RESET';

COMMIT;
