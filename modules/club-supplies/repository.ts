import "server-only";

import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import {
  type ClubSupplyCsvRow,
  type ClubSupplyImportPlan,
  clubSupplyImportFingerprint,
  planClubSupplyImport,
} from "@/modules/club-supplies/catalog-csv";

/**
 * Club supply catalog storage (#531): the conference-wide `ClubSupplyItem`
 * table (honors and master awards included), the `Honor` catalog fields the
 * import also sets, and each club's stock on hand. The catalog changes only
 * through the staff CSV import and the staff active toggle; nothing here is
 * seeded into production.
 */

export type ClubSupplyErrorCode = "ITEM_NOT_FOUND" | "PREVIEW_CHANGED" | "CATALOG_CONFLICT";

export class ClubSupplyError extends Error {
  constructor(public readonly code: ClubSupplyErrorCode, message: string) {
    super(message);
    this.name = "ClubSupplyError";
  }
}

function isUniqueConstraint(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

const catalogConflict = () => new ClubSupplyError(
  "CATALOG_CONFLICT",
  "Another change to the catalog landed at the same time. Run the preview again.",
);

type Client = Prisma.TransactionClient | ReturnType<typeof getPrisma>;

const itemSelect = {
  id: true,
  section: true,
  name: true,
  catalogNumber: true,
  sizeLabel: true,
  isActive: true,
  honorId: true,
  honor: { select: { code: true } },
} satisfies Prisma.ClubSupplyItemSelect;

function serializeItem(item: Prisma.ClubSupplyItemGetPayload<{ select: typeof itemSelect }>) {
  return {
    id: item.id,
    section: item.section,
    name: item.name,
    catalogNumber: item.catalogNumber,
    sizeLabel: item.sizeLabel,
    isActive: item.isActive,
    honorId: item.honorId,
    honorCode: item.honor?.code ?? null,
  };
}

export type ClubSupplyItemRecord = ReturnType<typeof serializeItem>;

/** Every catalog item by section then name: the staff catalog list. */
export async function listClubSupplyItems(): Promise<ClubSupplyItemRecord[]> {
  const items = await getPrisma().clubSupplyItem.findMany({
    select: itemSelect,
    orderBy: [{ section: "asc" }, { name: "asc" }],
  });
  return items.map(serializeItem);
}

async function catalogState(client: Client) {
  const [items, honors] = await Promise.all([
    client.clubSupplyItem.findMany({
      select: {
        id: true, section: true, name: true, normalizedName: true, catalogNumber: true,
        sizeLabel: true, isActive: true, honorId: true, updatedAt: true,
      },
    }),
    client.honor.findMany({ select: { id: true, code: true, name: true, catalogNumber: true, category: true, updatedAt: true } }),
  ]);
  return { items, honors };
}

async function planWithFingerprint(rows: readonly ClubSupplyCsvRow[], client: Client) {
  const { items, honors } = await catalogState(client);
  const plan = planClubSupplyImport(rows, items, honors);
  return { plan, fingerprint: clubSupplyImportFingerprint(plan, items, honors) };
}

/** The dry run: what the file would do against the catalog as it is now, and the fingerprint to confirm with. */
export async function previewClubSupplyImport(rows: readonly ClubSupplyCsvRow[]) {
  return planWithFingerprint(rows, getPrisma());
}

const IMPORT_TRANSACTION = { timeout: 60_000, maxWait: 10_000 };

/**
 * Applies an import (#531) in one transaction, re-planned inside it against
 * the catalog as it is at that moment. When that plan's fingerprint isn't the
 * one the preview returned, nothing is saved (`PREVIEW_CHANGED`). Items are
 * added or updated, never deleted. Audited with counts only.
 */
export async function applyClubSupplyImport(rows: readonly ClubSupplyCsvRow[], fingerprint: string, actorUserId: string) {
  let plan: ClubSupplyImportPlan;
  try {
    plan = await getPrisma().$transaction(async (tx) => {
      const current = await planWithFingerprint(rows, tx);
      if (current.fingerprint !== fingerprint) {
        throw new ClubSupplyError(
          "PREVIEW_CHANGED",
          "The file or the catalog changed since the preview. Review the new preview before saving.",
        );
      }
      const { steps, summary } = current.plan;
      const adds = steps.flatMap((step) => (step.action === "ADD" && step.write ? [step.write] : []));
      if (adds.length > 0) await tx.clubSupplyItem.createMany({ data: adds });
      for (const step of steps) {
        if (step.action === "UPDATE" && step.itemId && step.write) {
          await tx.clubSupplyItem.update({ where: { id: step.itemId }, data: step.write });
        }
        if (step.honorUpdate) {
          const { honorId, catalogNumber, category } = step.honorUpdate;
          await tx.honor.update({ where: { id: honorId }, data: { catalogNumber, category } });
        }
      }
      await writeAuditLog({
        actorUserId,
        action: "CLUB_SUPPLY_CATALOG_IMPORTED",
        entityType: "ClubSupplyItem",
        summary: `Imported the club supply catalog: ${summary.added} added, ${summary.updated} updated, ${summary.skipped} skipped.`,
        metadata: { ...summary },
      }, tx);
      return current.plan;
    }, IMPORT_TRANSACTION);
  } catch (error) {
    if (isUniqueConstraint(error)) throw catalogConflict();
    throw error;
  }
  return { ...plan, items: await listClubSupplyItems() };
}

/** Staff toggle (#531): marks one item active or inactive (a discontinued honor, say). */
export async function setClubSupplyItemActive(itemId: string, isActive: boolean, actorUserId: string) {
  try {
    await getPrisma().$transaction(async (tx) => {
      const item = await tx.clubSupplyItem.findUnique({ where: { id: itemId }, select: { id: true, isActive: true } });
      if (!item) throw new ClubSupplyError("ITEM_NOT_FOUND", "That catalog item could not be found.");
      if (item.isActive === isActive) return;
      await tx.clubSupplyItem.update({ where: { id: itemId }, data: { isActive } });
      await writeAuditLog({
        actorUserId,
        action: isActive ? "CLUB_SUPPLY_ITEM_ACTIVATED" : "CLUB_SUPPLY_ITEM_DEACTIVATED",
        entityType: "ClubSupplyItem",
        entityId: itemId,
        summary: isActive ? "Marked a club supply item active." : "Marked a club supply item inactive.",
        metadata: { isActive },
      }, tx);
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      throw new ClubSupplyError("ITEM_NOT_FOUND", "That catalog item could not be found.");
    }
    throw error;
  }
  return listClubSupplyItems();
}

export type ClubSupplyStockActor = { accountId: string } | { userId: string; actAsId: string };

export type ClubStockRow = {
  itemId: string;
  section: ClubSupplyItemRecord["section"];
  name: string;
  catalogNumber: string | null;
  sizeLabel: string | null;
  isActive: boolean;
  quantityOnHand: number;
};

/**
 * Every active catalog item with this club's quantity on hand (0 when it has
 * no row yet), plus any inactive item the club still holds stock of.
 */
export async function listClubStock(organizationId: string): Promise<ClubStockRow[]> {
  const [items, stock] = await Promise.all([
    getPrisma().clubSupplyItem.findMany({
      where: { OR: [{ isActive: true }, { stock: { some: { organizationId, quantityOnHand: { gt: 0 } } } }] },
      select: { id: true, section: true, name: true, catalogNumber: true, sizeLabel: true, isActive: true },
      orderBy: [{ section: "asc" }, { name: "asc" }],
    }),
    getPrisma().clubSupplyStock.findMany({ where: { organizationId }, select: { itemId: true, quantityOnHand: true } }),
  ]);
  const quantities = new Map(stock.map((row) => [row.itemId, row.quantityOnHand]));
  return items.map((item) => ({
    itemId: item.id,
    section: item.section,
    name: item.name,
    catalogNumber: item.catalogNumber,
    sizeLabel: item.sizeLabel,
    isActive: item.isActive,
    quantityOnHand: quantities.get(item.id) ?? 0,
  }));
}

/**
 * Records a club's on-hand count for one catalog item (#531), creating the
 * row the first time. Audited with the quantities only, against the stock
 * row itself.
 */
export async function setClubStockQuantity(
  organizationId: string,
  itemId: string,
  quantityOnHand: number,
  actor: ClubSupplyStockActor,
) {
  const attribution = "accountId" in actor
    ? { updatedByAccountId: actor.accountId, updatedByUserId: null }
    : { updatedByAccountId: null, updatedByUserId: actor.userId };
  try {
    return await getPrisma().$transaction(async (tx) => {
      const item = await tx.clubSupplyItem.findUnique({
        where: { id: itemId },
        select: { isActive: true, stock: { where: { organizationId }, select: { quantityOnHand: true } } },
      });
      // An inactive item stays editable only while the club still holds some.
      if (!item || (!item.isActive && item.stock.length === 0)) {
        throw new ClubSupplyError("ITEM_NOT_FOUND", "That catalog item could not be found.");
      }
      const previousQuantity = item.stock[0]?.quantityOnHand ?? 0;
      const row = await tx.clubSupplyStock.upsert({
        where: { organizationId_itemId: { organizationId, itemId } },
        create: { organizationId, itemId, quantityOnHand, ...attribution },
        update: { quantityOnHand, ...attribution },
        select: { id: true, itemId: true, quantityOnHand: true },
      });
      await writeAuditLog({
        ...("accountId" in actor ? {} : { actorUserId: actor.userId }),
        action: "CLUB_SUPPLY_STOCK_UPDATED",
        entityType: "ClubSupplyStock",
        entityId: row.id,
        summary: `Set a club supply stock quantity from ${previousQuantity} to ${quantityOnHand}.`,
        metadata: {
          organizationId,
          itemId,
          previousQuantity,
          quantityOnHand,
          ...("accountId" in actor ? { actorAttendeeAccountId: actor.accountId } : { actAsId: actor.actAsId }),
        },
      }, tx);
      return row;
    });
  } catch (error) {
    // Two first saves racing for the same club and item.
    if (isUniqueConstraint(error)) throw catalogConflict();
    throw error;
  }
}
