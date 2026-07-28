CREATE TYPE "EventContentSectionKind" AS ENUM ('RICH_TEXT', 'RESOURCE_LINKS');

CREATE TABLE "EventContentSection" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "kind" "EventContentSectionKind" NOT NULL DEFAULT 'RICH_TEXT',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "position" INTEGER NOT NULL,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventContentSection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EventContentLink" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "url" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "EventContentLink_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EventContentSection_eventId_position_idx" ON "EventContentSection"("eventId", "position");
CREATE INDEX "EventContentSection_eventId_isPublished_idx" ON "EventContentSection"("eventId", "isPublished");
CREATE INDEX "EventContentLink_sectionId_position_idx" ON "EventContentLink"("sectionId", "position");

ALTER TABLE "EventContentSection" ADD CONSTRAINT "EventContentSection_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventContentLink" ADD CONSTRAINT "EventContentLink_sectionId_fkey"
    FOREIGN KEY ("sectionId") REFERENCES "EventContentSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
