-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "checksAdultBackgrounds" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "BackgroundCheck" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'STERLING',
    "checkedOn" TEXT,
    "expiresOn" TEXT NOT NULL,
    "recordedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackgroundCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundCheck_personId_key" ON "BackgroundCheck"("personId");

-- CreateIndex
CREATE INDEX "BackgroundCheck_expiresOn_idx" ON "BackgroundCheck"("expiresOn");

-- AddForeignKey
ALTER TABLE "BackgroundCheck" ADD CONSTRAINT "BackgroundCheck_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
