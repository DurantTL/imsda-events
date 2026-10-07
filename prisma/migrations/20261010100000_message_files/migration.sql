-- CreateEnum
CREATE TYPE "MessageFileDisposition" AS ENUM ('ATTACHMENT', 'INLINE');

-- CreateTable
CREATE TABLE "MessageFile" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "isInlineImage" BOOLEAN NOT NULL DEFAULT false,
    "uploadedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageTemplateVersionFile" (
    "templateVersionId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageTemplateVersionFile_pkey" PRIMARY KEY ("templateVersionId","fileId")
);

-- CreateTable
CREATE TABLE "AnnouncementFile" (
    "announcementId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnnouncementFile_pkey" PRIMARY KEY ("announcementId","fileId")
);

-- CreateTable
CREATE TABLE "MessageOutboxFile" (
    "messageOutboxId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "disposition" "MessageFileDisposition" NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageOutboxFile_pkey" PRIMARY KEY ("messageOutboxId","fileId")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageFile_storageKey_key" ON "MessageFile"("storageKey");

-- CreateIndex
CREATE INDEX "MessageFile_eventId_createdAt_idx" ON "MessageFile"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "MessageTemplateVersionFile_fileId_idx" ON "MessageTemplateVersionFile"("fileId");

-- CreateIndex
CREATE INDEX "AnnouncementFile_fileId_idx" ON "AnnouncementFile"("fileId");

-- CreateIndex
CREATE INDEX "MessageOutboxFile_fileId_idx" ON "MessageOutboxFile"("fileId");

-- AddForeignKey
ALTER TABLE "MessageFile" ADD CONSTRAINT "MessageFile_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageFile" ADD CONSTRAINT "MessageFile_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageTemplateVersionFile" ADD CONSTRAINT "MessageTemplateVersionFile_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "MessageTemplateVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageTemplateVersionFile" ADD CONSTRAINT "MessageTemplateVersionFile_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "MessageFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementFile" ADD CONSTRAINT "AnnouncementFile_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementFile" ADD CONSTRAINT "AnnouncementFile_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "MessageFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageOutboxFile" ADD CONSTRAINT "MessageOutboxFile_messageOutboxId_fkey" FOREIGN KEY ("messageOutboxId") REFERENCES "MessageOutbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageOutboxFile" ADD CONSTRAINT "MessageOutboxFile_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "MessageFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

