-- CreateEnum
CREATE TYPE "HonorOfferingSpan" AS ENUM ('SINGLE_SESSION', 'ALL_SESSIONS');

-- CreateTable
CREATE TABLE "Honor" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Honor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HonorSession" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HonorSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HonorOffering" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "honorId" TEXT NOT NULL,
    "sessionId" TEXT,
    "span" "HonorOfferingSpan" NOT NULL,
    "capacity" INTEGER NOT NULL,
    "minimumAge" INTEGER,
    "perClubLimit" INTEGER,
    "teacherName" TEXT NOT NULL DEFAULT '',
    "location" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HonorOffering_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Honor_code_key" ON "Honor"("code");

-- CreateIndex
CREATE INDEX "Honor_isActive_name_idx" ON "Honor"("isActive", "name");

-- CreateIndex
CREATE INDEX "Honor_normalizedName_idx" ON "Honor"("normalizedName");

-- CreateIndex
CREATE INDEX "HonorSession_eventId_sortOrder_idx" ON "HonorSession"("eventId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "HonorSession_eventId_normalizedName_key" ON "HonorSession"("eventId", "normalizedName");

-- CreateIndex
CREATE INDEX "HonorOffering_eventId_isActive_idx" ON "HonorOffering"("eventId", "isActive");

-- CreateIndex
CREATE INDEX "HonorOffering_honorId_idx" ON "HonorOffering"("honorId");

-- CreateIndex
CREATE UNIQUE INDEX "HonorOffering_sessionId_honorId_key" ON "HonorOffering"("sessionId", "honorId");

-- AddForeignKey
ALTER TABLE "HonorSession" ADD CONSTRAINT "HonorSession_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HonorOffering" ADD CONSTRAINT "HonorOffering_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HonorOffering" ADD CONSTRAINT "HonorOffering_honorId_fkey" FOREIGN KEY ("honorId") REFERENCES "Honor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HonorOffering" ADD CONSTRAINT "HonorOffering_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "HonorSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Offering invariants the Prisma schema cannot express.
ALTER TABLE "HonorOffering"
  ADD CONSTRAINT "HonorOffering_capacity_nonnegative" CHECK ("capacity" >= 0),
  ADD CONSTRAINT "HonorOffering_minimumAge_nonnegative" CHECK ("minimumAge" IS NULL OR "minimumAge" >= 0),
  ADD CONSTRAINT "HonorOffering_perClubLimit_positive" CHECK ("perClubLimit" IS NULL OR "perClubLimit" >= 1),
  ADD CONSTRAINT "HonorOffering_span_session" CHECK (
    ("span" = 'SINGLE_SESSION' AND "sessionId" IS NOT NULL)
    OR ("span" = 'ALL_SESSIONS' AND "sessionId" IS NULL)
  );

-- One all-sessions offering per honor per event. (Single-session duplicates are
-- covered by HonorOffering_sessionId_honorId_key; NULL session IDs are distinct.)
CREATE UNIQUE INDEX "HonorOffering_eventId_honorId_all_sessions_key"
  ON "HonorOffering"("eventId", "honorId") WHERE "sessionId" IS NULL;
