-- CreateTable
CREATE TABLE "MemberHonorEntryVoid" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "voidedByAccountId" TEXT,
    "voidedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberHonorEntryVoid_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MemberHonorEntryVoid_entryId_key" ON "MemberHonorEntryVoid"("entryId");

-- AddForeignKey
ALTER TABLE "MemberHonorEntryVoid" ADD CONSTRAINT "MemberHonorEntryVoid_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "MemberHonorEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberHonorEntryVoid" ADD CONSTRAINT "MemberHonorEntryVoid_voidedByAccountId_fkey" FOREIGN KEY ("voidedByAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberHonorEntryVoid" ADD CONSTRAINT "MemberHonorEntryVoid_voidedByUserId_fkey" FOREIGN KEY ("voidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The reason is required and 3 to 500 characters. Never both actors (either
-- may be null after the actor's account is deleted, since the FKs SET NULL).
ALTER TABLE "MemberHonorEntryVoid" ADD CONSTRAINT "MemberHonorEntryVoid_reason_length_check" CHECK (char_length("reason") BETWEEN 3 AND 500);
ALTER TABLE "MemberHonorEntryVoid" ADD CONSTRAINT "MemberHonorEntryVoid_one_actor_check" CHECK (num_nonnulls("voidedByAccountId", "voidedByUserId") <= 1);
