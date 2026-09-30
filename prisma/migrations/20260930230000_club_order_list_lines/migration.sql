-- Order helper list edits (#654). Additive only: no existing table or row changes.
CREATE TABLE "ClubOrderListLine" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubOrderListLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ClubOrderListLine_quantity_check" CHECK ("quantity" >= 0)
);

CREATE UNIQUE INDEX "ClubOrderListLine_organizationId_itemId_key" ON "ClubOrderListLine"("organizationId", "itemId");

CREATE INDEX "ClubOrderListLine_itemId_idx" ON "ClubOrderListLine"("itemId");

ALTER TABLE "ClubOrderListLine" ADD CONSTRAINT "ClubOrderListLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClubOrderListLine" ADD CONSTRAINT "ClubOrderListLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ClubSupplyItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
