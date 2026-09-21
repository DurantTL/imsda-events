ALTER TABLE "CommunityPost"
  ADD COLUMN "authorDeletedAt" TIMESTAMP(3),
  ADD COLUMN "lastEditedAt" TIMESTAMP(3);

CREATE TABLE "CommunityPostRevision" (
  "id" TEXT NOT NULL,
  "postId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CommunityPostRevision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CommunityPostRevision_postId_createdAt_idx"
  ON "CommunityPostRevision"("postId", "createdAt");

ALTER TABLE "CommunityPostRevision"
  ADD CONSTRAINT "CommunityPostRevision_postId_fkey"
  FOREIGN KEY ("postId") REFERENCES "CommunityPost"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
