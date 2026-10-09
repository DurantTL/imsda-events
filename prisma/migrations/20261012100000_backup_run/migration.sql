-- Additive: status records written by the backup container and read by
-- /api/health. Times, sizes and pass/fail only.
CREATE TABLE "BackupRun" (
  "id" SERIAL NOT NULL,
  "kind" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3) NOT NULL,
  "ok" BOOLEAN NOT NULL,
  "dumpBytes" BIGINT,
  "assetsBytes" BIGINT,
  "offsiteOk" BOOLEAN,

  CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BackupRun_kind_finishedAt_idx" ON "BackupRun"("kind", "finishedAt");
