-- #527: the uploaded CSV becomes the single stored background-check list,
-- matched to people at lookup instead of at upload. Replaces the old
-- one-row-per-person "BackgroundCheck" table with an upload/entry/match
-- design, and carries every existing row over as a migrated match so
-- nobody's current status changes the day this ships.

-- CreateEnum
CREATE TYPE "BackgroundCheckMatchSource" AS ENUM ('IDENTITY', 'AUTO', 'MANUAL', 'MIGRATED');

-- CreateTable
CREATE TABLE "BackgroundCheckUpload" (
    "id" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "added" INTEGER NOT NULL,
    "changed" INTEGER NOT NULL,
    "dropped" INTEGER NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackgroundCheckUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackgroundCheckEntry" (
    "id" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "normalizedName" TEXT,
    "email" TEXT,
    "sealedBirthDate" TEXT,
    "site" TEXT,
    "sourceUserId" TEXT,
    "identityKey" TEXT NOT NULL,
    "complianceStatus" "BackgroundCheckComplianceStatus",
    "checkedOn" TEXT,
    "expiresOn" TEXT,
    "issuesNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackgroundCheckEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackgroundCheckMatch" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "matchedBy" "BackgroundCheckMatchSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackgroundCheckMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackgroundCheckReview" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "candidatePersonIds" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackgroundCheckReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BackgroundCheckUpload_createdAt_idx" ON "BackgroundCheckUpload"("createdAt");

-- CreateIndex
CREATE INDEX "BackgroundCheckEntry_normalizedName_idx" ON "BackgroundCheckEntry"("normalizedName");

-- CreateIndex
CREATE INDEX "BackgroundCheckEntry_uploadId_idx" ON "BackgroundCheckEntry"("uploadId");

-- CreateIndex
CREATE INDEX "BackgroundCheckEntry_identityKey_idx" ON "BackgroundCheckEntry"("identityKey");

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundCheckMatch_personId_key" ON "BackgroundCheckMatch"("personId");

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundCheckMatch_entryId_key" ON "BackgroundCheckMatch"("entryId");

-- CreateIndex
CREATE INDEX "BackgroundCheckReview_entryId_idx" ON "BackgroundCheckReview"("entryId");

-- AddForeignKey
ALTER TABLE "BackgroundCheckEntry" ADD CONSTRAINT "BackgroundCheckEntry_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "BackgroundCheckUpload"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundCheckMatch" ADD CONSTRAINT "BackgroundCheckMatch_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundCheckMatch" ADD CONSTRAINT "BackgroundCheckMatch_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "BackgroundCheckEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundCheckReview" ADD CONSTRAINT "BackgroundCheckReview_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "BackgroundCheckEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Remembered roster user_ids (#527 B2): one key format everywhere. Every
-- ROSTER_IMPORT identity recorded before this migration holds the raw
-- provider user_id; the list keys a user_id as "userId:<id>", so rewrite
-- them to that format here, in the same transaction, so none is orphaned.
UPDATE "ExternalIdentity"
SET "externalId" = 'userId:' || "externalId", "updatedAt" = CURRENT_TIMESTAMP
WHERE "provider" = 'ROSTER_IMPORT'
  AND "providerScope" = ''
  AND "externalId" NOT LIKE 'userId:%';

-- Data migration: carry every existing "BackgroundCheck" row over as a
-- migrated entry + match, so nobody's current status changes today. Names
-- come from "Person" (the old table never stored them); email, birth date,
-- and site were never captured by the old table either, so they are left
-- unset here — the next real upload fills them in and re-matches normally.
--
-- "normalizedName" is deliberately left NULL (#527 B3): names are only ever
-- normalized in TypeScript (`matchableName`), never approximated in SQL, so
-- accents and punctuation can't normalize differently here than at lookup.
-- The first background-check refresh or upload after deploy fills it in
-- (`backfillNormalizedNames`); nothing about the migrated match itself
-- depends on it. A remembered user_id keys the entry the same way an upload
-- will ("userId:<id>"), so the first roster upload counts that person as
-- "changed", not dropped and re-added.
DO $$
DECLARE
  migration_upload_id TEXT := 'mig20260928210000';
  row_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO row_count FROM "BackgroundCheck" bc JOIN "Person" p ON p."id" = bc."personId";
  IF row_count > 0 THEN
    INSERT INTO "BackgroundCheckUpload" ("id", "format", "rowCount", "added", "changed", "dropped", "uploadedByUserId", "createdAt")
    VALUES (migration_upload_id, 'MIGRATION', row_count, row_count, 0, 0, 'MIGRATION', CURRENT_TIMESTAMP);

    INSERT INTO "BackgroundCheckEntry" (
      "id", "uploadId", "line", "firstName", "lastName", "normalizedName",
      "email", "sealedBirthDate", "site", "sourceUserId", "identityKey",
      "complianceStatus", "checkedOn", "expiresOn", "issuesNote", "createdAt", "updatedAt"
    )
    SELECT
      'migentry_' || bc."id",
      migration_upload_id,
      ROW_NUMBER() OVER (ORDER BY bc."id"),
      p."firstName",
      p."lastName",
      NULL,
      NULL,
      NULL,
      NULL,
      substring(ei."externalId" FROM 8),
      COALESCE(ei."externalId", 'migrated:' || bc."id"),
      bc."complianceStatus",
      bc."checkedOn",
      bc."expiresOn",
      bc."issuesNote",
      bc."createdAt",
      bc."updatedAt"
    FROM "BackgroundCheck" bc
    JOIN "Person" p ON p."id" = bc."personId"
    LEFT JOIN "ExternalIdentity" ei ON ei."personId" = bc."personId" AND ei."provider" = 'ROSTER_IMPORT' AND ei."providerScope" = '';

    INSERT INTO "BackgroundCheckMatch" ("id", "personId", "entryId", "matchedBy", "createdAt", "updatedAt")
    SELECT
      'migmatch_' || bc."id",
      bc."personId",
      'migentry_' || bc."id",
      'MIGRATED',
      bc."createdAt",
      bc."updatedAt"
    FROM "BackgroundCheck" bc
    JOIN "Person" p ON p."id" = bc."personId";
  END IF;
END $$;

-- Keep the old table for one release (#527 N4): renamed, never written to
-- again, and ignored by Prisma Client. A later migration drops it; see
-- docs/BACKGROUND-CHECK-LIST-MIGRATION.md. Its constraint and index names
-- are left as they were (the schema maps them explicitly).
ALTER TABLE "BackgroundCheck" RENAME TO "BackgroundCheck_pre527";
