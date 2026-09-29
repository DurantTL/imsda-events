-- AlterEnum
-- Additive (#598): a match made on the name alone, when the row's site didn't
-- match but the name is the only one on the list and among the candidates.
ALTER TYPE "BackgroundCheckMatchSource" ADD VALUE 'NAME_ONLY';

-- CreateTable
-- Additive (#598): a staff "not the same person" decision, remembered by the
-- row's identity key so it survives every upload. No foreign keys: a row's key
-- outlives any one upload, and a deleted person just leaves an inert pair.
CREATE TABLE "BackgroundCheckRejectedPairing" (
    "id" TEXT NOT NULL,
    "identityKey" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "rejectedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackgroundCheckRejectedPairing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundCheckRejectedPairing_identityKey_personId_key" ON "BackgroundCheckRejectedPairing"("identityKey", "personId");
