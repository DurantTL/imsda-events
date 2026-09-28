-- Q1 (#157): provenance for reviewed annual event cloning. One new table; no
-- existing table is touched, so there is nothing to backfill.

-- CreateTable
CREATE TABLE "EventCloneRecord" (
    "id" TEXT NOT NULL,
    "sourceEventId" TEXT,
    "resultEventId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "requestInput" JSONB NOT NULL,
    "sourceFingerprint" TEXT NOT NULL,
    "sourceVersions" JSONB NOT NULL,
    "selections" JSONB NOT NULL,
    "exclusions" JSONB NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventCloneRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventCloneRecord_resultEventId_key" ON "EventCloneRecord"("resultEventId");

-- CreateIndex
CREATE UNIQUE INDEX "EventCloneRecord_actorUserId_requestKey_key" ON "EventCloneRecord"("actorUserId", "requestKey");

-- CreateIndex
CREATE INDEX "EventCloneRecord_sourceEventId_createdAt_idx" ON "EventCloneRecord"("sourceEventId", "createdAt");

-- AddForeignKey
ALTER TABLE "EventCloneRecord" ADD CONSTRAINT "EventCloneRecord_sourceEventId_fkey" FOREIGN KEY ("sourceEventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventCloneRecord" ADD CONSTRAINT "EventCloneRecord_resultEventId_fkey" FOREIGN KEY ("resultEventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventCloneRecord" ADD CONSTRAINT "EventCloneRecord_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
