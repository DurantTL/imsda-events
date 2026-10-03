-- #510: up to two guardian contacts per club roster member. Additive only:
-- one new table, no change to any existing table or row. Plain text on purpose
-- (director decision, Oct 1, 2026). Rows cascade with the roster member, and the
-- app also deletes them explicitly when a member is removed.

-- CreateTable
CREATE TABLE "ClubRosterGuardian" (
    "id" TEXT NOT NULL,
    "rosterMemberId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "relationship" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubRosterGuardian_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ClubRosterGuardian_position_check" CHECK ("position" IN (1, 2))
);

-- CreateIndex
CREATE UNIQUE INDEX "ClubRosterGuardian_rosterMemberId_position_key" ON "ClubRosterGuardian"("rosterMemberId", "position");

-- AddForeignKey
ALTER TABLE "ClubRosterGuardian" ADD CONSTRAINT "ClubRosterGuardian_rosterMemberId_fkey" FOREIGN KEY ("rosterMemberId") REFERENCES "ClubRosterMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
