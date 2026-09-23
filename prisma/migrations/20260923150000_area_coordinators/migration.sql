-- Area Coordinators (#387).
-- CreateTable
CREATE TABLE "AreaCoordinatorGrant" (
    "id" TEXT NOT NULL,
    "attendeeAccountId" TEXT NOT NULL,
    "grantedByUserId" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

CONSTRAINT "AreaCoordinatorGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AreaCoordinatorGrant_attendeeAccountId_key" ON "AreaCoordinatorGrant"("attendeeAccountId");

-- CreateIndex
CREATE INDEX "AreaCoordinatorGrant_revokedAt_idx" ON "AreaCoordinatorGrant"("revokedAt");

-- AddForeignKey
ALTER TABLE "AreaCoordinatorGrant" ADD CONSTRAINT "AreaCoordinatorGrant_attendeeAccountId_fkey" FOREIGN KEY ("attendeeAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
