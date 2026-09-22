CREATE TABLE "SystemJobHeartbeat" (
  "job" TEXT NOT NULL,
  "lastSucceededAt" TIMESTAMP(3),
  "lastFailedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SystemJobHeartbeat_pkey" PRIMARY KEY ("job")
);
