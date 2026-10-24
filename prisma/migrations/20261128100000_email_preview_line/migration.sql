-- Inbox preview line (preheader) for event emails (#836). Additive only: three nullable text columns, no default,
-- no backfill, no index. Every existing row keeps NULL, which means "no preview line", and a message with no preview
-- line renders byte-for-byte as it did before. Nothing is read, moved or rewritten.

-- AlterTable
ALTER TABLE "Announcement" ADD COLUMN     "preheader" TEXT;

-- AlterTable
ALTER TABLE "MessageTemplateVersion" ADD COLUMN     "preheaderTemplate" TEXT;

-- AlterTable
ALTER TABLE "MessageOutbox" ADD COLUMN     "preheaderSnapshot" TEXT;
