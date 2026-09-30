-- CreateTable
-- Additive (#619): a name-only or first-name-variant match of a list row that
-- has no roster user_id (Sterling-style rows), remembered by the row's identity
-- key so the next upload matches it again without listing it as new. Rows with
-- a user_id are remembered as an ExternalIdentity instead. No foreign keys, like
-- BackgroundCheckRejectedPairing: a row's key outlives any one upload, and a
-- deleted person just leaves an inert row (matching checks the person exists).
CREATE TABLE "BackgroundCheckRememberedMatch" (
    "id" TEXT NOT NULL,
    "identityKey" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "matchedName" TEXT NOT NULL,
    "matchedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackgroundCheckRememberedMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundCheckRememberedMatch_identityKey_key" ON "BackgroundCheckRememberedMatch"("identityKey");
