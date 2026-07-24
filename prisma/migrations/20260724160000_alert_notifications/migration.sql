-- The signals existed; nothing watched them. A failed payment webhook paged
-- nobody. One row per alert condition, so a condition that persists pages once
-- per repeat window instead of every time the monitor runs.
CREATE TABLE "AlertNotification" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSentAt" TIMESTAMP(3) NOT NULL,
    "sendCount" INTEGER NOT NULL DEFAULT 1,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "AlertNotification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AlertNotification_key_key" ON "AlertNotification"("key");
CREATE INDEX "AlertNotification_lastSentAt_idx" ON "AlertNotification"("lastSentAt");
CREATE INDEX "AlertNotification_resolvedAt_idx" ON "AlertNotification"("resolvedAt");
