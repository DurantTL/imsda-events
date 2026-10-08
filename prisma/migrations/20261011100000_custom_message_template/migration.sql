-- #850: a staff-written "Custom message" template for Email selected.
--
-- Only the enum value is added here. The template row is created for every
-- event, existing and new, by the same lazy provisioning the other templates
-- use (ensureEventMessagingDefaults), and it starts with no published
-- version: staff write the subject and body, and publishing is what makes it
-- sendable. Nothing is seeded, so no existing message history is touched.

-- AlterEnum
ALTER TYPE "MessageTemplateKey" ADD VALUE IF NOT EXISTS 'CUSTOM_MESSAGE';
