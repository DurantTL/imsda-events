CREATE TABLE "EventAsset" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventAsset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EventAsset_storageKey_key" ON "EventAsset"("storageKey");
CREATE INDEX "EventAsset_eventId_createdAt_idx" ON "EventAsset"("eventId", "createdAt");

ALTER TABLE "EventAsset" ADD CONSTRAINT "EventAsset_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventAsset" ADD CONSTRAINT "EventAsset_uploadedByUserId_fkey"
    FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A tile pointed somewhere before this migration, so every existing row keeps
-- its address and the column can be relaxed without a default.
ALTER TABLE "EventContentLink" ALTER COLUMN "url" DROP NOT NULL;
ALTER TABLE "EventContentLink" ADD COLUMN "assetId" TEXT;

CREATE INDEX "EventContentLink_assetId_idx" ON "EventContentLink"("assetId");

-- Restrict, not cascade: deleting a file a published page still links to should
-- fail loudly rather than quietly leave a tile pointing at nothing.
ALTER TABLE "EventContentLink" ADD CONSTRAINT "EventContentLink_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "EventAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A tile is an address or a file, never both and never neither. Prisma cannot
-- express this, so the database carries it.
ALTER TABLE "EventContentLink" ADD CONSTRAINT "EventContentLink_target_xor"
    CHECK (("url" IS NOT NULL AND "assetId" IS NULL) OR ("url" IS NULL AND "assetId" IS NOT NULL));
