-- Additive: manual ticks for the System readiness page (#870).
CREATE TABLE "SystemReadinessTick" (
    "itemKey" TEXT NOT NULL,
    "tickedByUserId" TEXT,
    "tickedByName" TEXT NOT NULL,
    "tickedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "SystemReadinessTick_pkey" PRIMARY KEY ("itemKey")
);
