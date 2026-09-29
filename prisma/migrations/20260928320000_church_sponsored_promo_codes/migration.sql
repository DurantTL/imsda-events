-- Church-sponsored promo codes (#545): staff may link a promo code on a GENERAL
-- event to a sponsoring active CHURCH organization. What the church owes is
-- computed on demand from PromoCodeRedemption (like church-billed club
-- registrations, #409); nothing is stored per redemption.
-- Restrict on delete: a church that has sponsored a code must not silently lose
-- the billing history. Deleting such a church is refused with a readable
-- message (the organization deletion check lists its sponsored codes), and
-- deactivating it is the way to retire it.
-- Hand-written; matches `prisma migrate diff` against the schema exactly.

-- AlterTable
ALTER TABLE "PromoCode" ADD COLUMN     "sponsoringOrganizationId" TEXT;

-- CreateIndex
CREATE INDEX "PromoCode_sponsoringOrganizationId_idx" ON "PromoCode"("sponsoringOrganizationId");

-- AddForeignKey
ALTER TABLE "PromoCode" ADD CONSTRAINT "PromoCode_sponsoringOrganizationId_fkey" FOREIGN KEY ("sponsoringOrganizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
