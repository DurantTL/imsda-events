import "server-only";

import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import {
  availableStock,
  buildOrderLines,
  quantityToOrder,
  splitNeedsByStock,
  type OrderCatalogItem,
  type OrderLine,
  type PickListEntry,
} from "@/modules/club-orders/domain";
import type { ClubSupplyStockActor } from "@/modules/club-supplies/repository";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { itemAndSize } from "@/modules/uniforms/domain";

/**
 * Club order fulfillment storage (#487): a reusable order and stock layer
 * keyed on `ClubSupplyItem` (#531). It knows nothing about where a need came
 * from — a caller (`modules/honors/order-source.ts` today) hands it need
 * candidates keyed by `sourceType`/`sourceId`, and this module tracks each
 * one from NEEDED through ORDERED, RECEIVED, and AWARDED, moving
 * `ClubSupplyStock` (#531) along the way.
 *
 * The stock model. For each club and item:
 *   - on hand is `ClubSupplyStock.quantityOnHand`;
 *   - reserved is the RECEIVED needs (arrived for a named person, not yet
 *     handed out);
 *   - available is on hand less reserved, never below zero (`availableStock`).
 * The order list orders `needed + extras - available`. The oldest NEEDED needs
 * that available stock already covers are "ready to hand out, from stock"
 * and may go straight from NEEDED to AWARDED; the rest go on the order.
 *
 * Concurrency. Every write that moves needs or stock for a club takes the
 * same per-club transaction lock (`lockClubOrders`) first, and every status
 * change is a guarded `updateMany` whose moved count is what's acted on, so
 * two taps of the same button (or two directors at once) can never create a
 * phantom batch, receive twice, or award the same need twice.
 */

export type ClubOrderActor = ClubSupplyStockActor;

export type ClubOrderErrorCode = "NOTHING_TO_ORDER" | "BATCH_NOT_FOUND" | "ALREADY_RECEIVED" | "ORDER_CHANGED" | "NOT_ENOUGH_STOCK" | "ITEM_NOT_ORDERABLE" | "MEMBER_NOT_ON_ROSTER";

export class ClubOrderError extends Error {
  constructor(public readonly code: ClubOrderErrorCode, message: string) {
    super(message);
    this.name = "ClubOrderError";
  }
}

export type Db = Prisma.TransactionClient | ReturnType<typeof getPrisma>;

/** Serializes every order/stock write for one club (#487), released when the transaction ends. */
export async function lockClubOrders(tx: Prisma.TransactionClient, organizationId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`club-orders:${organizationId}`}))`;
}

function createdByFields(actor: ClubOrderActor) {
  return "accountId" in actor
    ? { createdByAccountId: actor.accountId, createdByUserId: null }
    : { createdByAccountId: null, createdByUserId: actor.userId };
}

function receivedByFields(actor: ClubOrderActor) {
  return "accountId" in actor
    ? { receivedByAccountId: actor.accountId, receivedByUserId: null }
    : { receivedByAccountId: null, receivedByUserId: actor.userId };
}

export function auditActorFields(actor: ClubOrderActor) {
  return {
    actorFields: "userId" in actor ? { actorUserId: actor.userId } : {},
    metadata: "accountId" in actor ? { actorAttendeeAccountId: actor.accountId } : { actAsId: actor.actAsId },
  };
}

/**
 * Uniform needs of people who left (#497): a NEEDED uniform need whose member
 * is no longer ACTIVE on this club's roster this club year is removed, audited
 * by count, so it is never ordered. Uniform needs are NOT moved to a new club
 * on a transfer (unlike honors): sizes and needs are club-specific, and the new
 * club records its own. ORDERED, RECEIVED and AWARDED needs stay where they are.
 * Runs under the club's lock, in the caller's transaction.
 */
export async function removeDepartedMemberNeedsInTx(tx: Prisma.TransactionClient, organizationId: string, now = new Date()) {
  const needed = await tx.clubOrderNeed.findMany({
    where: { organizationId, sourceType: "UNIFORM", status: "NEEDED" },
    select: { id: true, personId: true },
  });
  if (needed.length === 0) return { removed: 0 };
  const active = await tx.clubRosterMember.findMany({
    where: { organizationId, clubYear: clubYearFor(now), status: "ACTIVE", personId: { in: [...new Set(needed.map((need) => need.personId))] } },
    select: { personId: true },
  });
  const activeIds = new Set(active.map((member) => member.personId));
  const departed = needed.filter((need) => !activeIds.has(need.personId)).map((need) => need.id);
  if (departed.length === 0) return { removed: 0 };
  const removed = await tx.clubOrderNeed.deleteMany({ where: { id: { in: departed }, organizationId, sourceType: "UNIFORM", status: "NEEDED" } });
  if (removed.count > 0) {
    await writeAuditLog({
      action: "CLUB_UNIFORM_NEEDS_DEPARTED_REMOVED",
      entityType: "ClubOrderNeed",
      summary: `Removed ${removed.count} not-yet-ordered uniform need${removed.count === 1 ? "" : "s"} for members no longer on the roster.`,
      metadata: { organizationId, needCount: removed.count },
    }, tx);
  }
  return { removed: removed.count };
}

export async function removeDepartedMemberNeeds(organizationId: string, now = new Date()) {
  return getPrisma().$transaction(async (tx) => {
    await lockClubOrders(tx, organizationId);
    return removeDepartedMemberNeedsInTx(tx, organizationId, now);
  });
}

export type NeedCandidate = { sourceId: string; personId: string; itemId: string | null; sourceLabel?: string; sourceDate?: string };

/**
 * Records new needs from one source (#487), skipping any `sourceId` this
 * source has already recorded (the unique `[sourceType, sourceId]` index).
 * Safe to call again and again: a need already on file creates nothing new.
 * Only editors' visits and write paths call it; view-only roles read what's
 * on file.
 */
export async function syncOrderNeeds(organizationId: string, sourceType: "HONOR", candidates: readonly NeedCandidate[]) {
  if (candidates.length === 0) return { count: 0 };
  return getPrisma().clubOrderNeed.createMany({
    data: candidates.map((candidate) => ({
      organizationId,
      sourceType,
      sourceId: candidate.sourceId,
      personId: candidate.personId,
      itemId: candidate.itemId,
      sourceLabel: candidate.sourceLabel ?? "",
      sourceDate: candidate.sourceDate ?? "",
    })),
    skipDuplicates: true,
  });
}

/**
 * Brings this club's not-yet-ordered needs in line with the source (#487),
 * under the club's lock:
 *   - a NEEDED need takes the catalog item its source is linked to *now*
 *     (`itemBySourceId`), so an honor linked in the catalog after its need
 *     was recorded (null -> item), or re-linked to another item, is picked
 *     up on the next sync;
 *   - a NEEDED need whose source was withdrawn (`withdrawnSourceIds`: the
 *     completion was corrected away) is removed, audited by count. If it is
 *     completed again later, the next sync records it afresh.
 * ORDERED, RECEIVED, and AWARDED needs are never touched: they belong to an
 * order already placed.
 */
export async function reconcileNeededNeeds(
  organizationId: string,
  sourceType: "HONOR",
  itemBySourceId: ReadonlyMap<string, string | null>,
  withdrawnSourceIds: readonly string[],
) {
  const sourceIds = [...itemBySourceId.keys()];
  if (sourceIds.length === 0 && withdrawnSourceIds.length === 0) return { relinked: 0, withdrawn: 0 };
  return getPrisma().$transaction(async (tx) => {
    await lockClubOrders(tx, organizationId);
    const needed = sourceIds.length === 0 ? [] : await tx.clubOrderNeed.findMany({
      where: { organizationId, sourceType, status: "NEEDED", sourceId: { in: sourceIds } },
      select: { id: true, sourceId: true, itemId: true },
    });
    const idsByTarget = new Map<string | null, string[]>();
    for (const need of needed) {
      const target = itemBySourceId.get(need.sourceId) ?? null;
      if (need.itemId === target) continue;
      idsByTarget.set(target, [...(idsByTarget.get(target) ?? []), need.id]);
    }
    let relinked = 0;
    for (const [itemId, ids] of idsByTarget) {
      relinked += (await tx.clubOrderNeed.updateMany({ where: { id: { in: ids }, organizationId, status: "NEEDED" }, data: { itemId } })).count;
    }
    const withdrawn = withdrawnSourceIds.length === 0 ? 0 : (await tx.clubOrderNeed.deleteMany({
      where: { organizationId, sourceType, status: "NEEDED", sourceId: { in: [...withdrawnSourceIds] } },
    })).count;
    if (withdrawn > 0) {
      await writeAuditLog({
        action: "CLUB_ORDER_NEEDS_WITHDRAWN",
        entityType: "ClubOrderNeed",
        summary: `Removed ${withdrawn} not-yet-ordered club supply need${withdrawn === 1 ? "" : "s"} whose completion was withdrawn.`,
        metadata: { organizationId, sourceType, needCount: withdrawn },
      }, tx);
    }
    return { relinked, withdrawn };
  });
}

/** NEEDED (not yet ordered) needs for these source ids recorded under some other club (#487 transfers). */
export async function listNeededNeedsElsewhere(organizationId: string, sourceType: "HONOR", sourceIds: readonly string[]) {
  if (sourceIds.length === 0) return [];
  return getPrisma().clubOrderNeed.findMany({
    where: { sourceType, sourceId: { in: [...sourceIds] }, status: "NEEDED", organizationId: { not: organizationId } },
    select: { id: true, sourceId: true, personId: true, organizationId: true },
  });
}

/**
 * A NEEDED need follows its person to their current club (#487): the need
 * moves to `organizationId`, but only while it is still NEEDED. Anything
 * already ordered, received, or awarded stays with the club that ordered it.
 */
export async function moveNeededNeedsToClub(organizationId: string, needs: ReadonlyArray<{ id: string; organizationId: string }>) {
  if (needs.length === 0) return { count: 0 };
  return getPrisma().$transaction(async (tx) => {
    for (const club of [...new Set([organizationId, ...needs.map((need) => need.organizationId)])].sort()) {
      await lockClubOrders(tx, club);
    }
    return tx.clubOrderNeed.updateMany({
      where: { id: { in: needs.map((need) => need.id) }, status: "NEEDED" },
      data: { organizationId },
    });
  });
}

const itemSelect = { id: true, name: true, catalogNumber: true } satisfies Prisma.ClubSupplyItemSelect;

function toCatalogItem(item: { id: string; name: string; catalogNumber: string | null }): OrderCatalogItem {
  return { itemId: item.id, name: item.name, catalogNumber: item.catalogNumber };
}

/** The oldest need first: the one stock covers first, the same order everywhere. */
const oldestFirst: Prisma.ClubOrderNeedOrderByWithRelationInput[] = [{ sourceDate: "asc" }, { createdAt: "asc" }, { id: "asc" }];

/** Available stock per item (on hand less RECEIVED-not-awarded), for the given items. */
async function availableByItem(db: Db, organizationId: string, itemIds: readonly string[]) {
  if (itemIds.length === 0) return new Map<string, number>();
  const [stock, received] = await Promise.all([
    db.clubSupplyStock.findMany({ where: { organizationId, itemId: { in: [...itemIds] } }, select: { itemId: true, quantityOnHand: true } }),
    db.clubOrderNeed.groupBy({ by: ["itemId"], where: { organizationId, status: "RECEIVED", itemId: { in: [...itemIds] } }, _count: { _all: true } }),
  ]);
  const reserved = new Map(received.map((row) => [row.itemId, row._count._all]));
  const onHand = new Map(stock.map((row) => [row.itemId, row.quantityOnHand]));
  return new Map(itemIds.map((itemId) => [itemId, availableStock(onHand.get(itemId) ?? 0, reserved.get(itemId) ?? 0)]));
}

function groupByItem<T extends { itemId: string | null }>(needs: readonly T[]) {
  const byItem = new Map<string, T[]>();
  for (const need of needs) {
    if (need.itemId === null) continue;
    const group = byItem.get(need.itemId) ?? [];
    group.push(need);
    byItem.set(need.itemId, group);
  }
  return byItem;
}

const neededSelect = {
  id: true, sourceType: true, sourceId: true, personId: true, itemId: true, sourceLabel: true, sourceDate: true, createdAt: true,
  item: { select: { ...itemSelect, section: true } },
} satisfies Prisma.ClubOrderNeedSelect;

type NeededRow = Prisma.ClubOrderNeedGetPayload<{ select: typeof neededSelect }>;

/** Every NEEDED need for a club, grouped by item, with available stock and which needs it already covers. */
async function neededPicture(organizationId: string) {
  const needs: NeededRow[] = await getPrisma().clubOrderNeed.findMany({
    where: { organizationId, status: "NEEDED" },
    orderBy: oldestFirst,
    select: neededSelect,
  });
  const byItem = groupByItem(needs);
  const available = await availableByItem(getPrisma(), organizationId, [...byItem.keys()]);
  const fromStock = new Set<string>();
  for (const [itemId, group] of byItem) {
    for (const need of splitNeedsByStock(group, available.get(itemId) ?? 0).fromStock) fromStock.add(need.id);
  }
  return { needs, byItem, available, fromStock };
}

type NeededPicture = Awaited<ReturnType<typeof neededPicture>>;

export type UnmatchedNeed = { sourceId: string; personId: string };

function orderListFrom(picture: NeededPicture, extraByItem: ReadonlyMap<string, number>) {
  const items = [...picture.byItem.values()].map((group) => toCatalogItem(group[0].item!));
  const neededByItem = new Map([...picture.byItem].map(([itemId, group]) => [itemId, group.length]));
  const lines = buildOrderLines(items, neededByItem, picture.available, extraByItem);
  const unmatched: UnmatchedNeed[] = picture.needs
    .filter((need) => need.itemId === null)
    .map((need) => ({ sourceId: need.sourceId, personId: need.personId }));
  return { lines, unmatched };
}

/**
 * The order screen's data (#487): one line per catalog item with an open
 * need, extras applied, available stock subtracted, never below zero. Extras
 * only apply to items on the list. Needs whose honor has no matching catalog
 * item at all come back separately as `unmatched`, flagged rather than
 * silently dropped.
 */
export async function listOrderList(
  organizationId: string,
  extraByItem: ReadonlyMap<string, number> = new Map(),
): Promise<{ lines: OrderLine[]; unmatched: UnmatchedNeed[] }> {
  return orderListFrom(await neededPicture(organizationId), extraByItem);
}

/**
 * Places an order (#487). Under the club's lock it reads the NEEDED needs,
 * works out per item how many available stock already covers (those stay
 * NEEDED, ready to hand out from stock) and how many must be ordered, moves
 * exactly those to ORDERED with a guarded update, and records each line's
 * `quantityOrdered` (needed + extras - available, never below zero). If no
 * need would move, no batch is created: NOTHING_TO_ORDER.
 */
export async function createOrderBatch(organizationId: string, extras: Record<string, number>, actor: ClubOrderActor) {
  // Never order a departed member's uniform (#497). Its own transaction, so the
  // removal stays even when this order turns out to have nothing left to order.
  await removeDepartedMemberNeeds(organizationId);
  return getPrisma().$transaction(async (tx) => {
    await lockClubOrders(tx, organizationId);
    const needs = await tx.clubOrderNeed.findMany({
      where: { organizationId, status: "NEEDED", itemId: { not: null } },
      orderBy: oldestFirst,
      select: { id: true, itemId: true },
    });
    const byItem = groupByItem(needs);
    const itemIds = [...byItem.keys()];
    const [items, available] = await Promise.all([
      tx.clubSupplyItem.findMany({ where: { id: { in: itemIds } }, select: itemSelect }),
      availableByItem(tx, organizationId, itemIds),
    ]);
    const plan = items.map((item) => {
      const group = byItem.get(item.id) ?? [];
      const inStock = available.get(item.id) ?? 0;
      const extra = Math.max(0, Math.trunc(extras[item.id] ?? 0));
      return {
        item: toCatalogItem(item),
        needed: group.length,
        extra,
        inStock,
        quantityOrdered: quantityToOrder(group.length, extra, inStock),
        moveIds: splitNeedsByStock(group.map((need) => need.id), inStock).toOrder,
      };
    });
    const moveIds = plan.flatMap((line) => line.moveIds);
    if (moveIds.length === 0) {
      throw new ClubOrderError(
        "NOTHING_TO_ORDER",
        needs.length > 0 ? "Everything needed is already in stock. Hand it out from stock instead." : "There's nothing to order right now.",
      );
    }

    const batch = await tx.clubSupplyOrderBatch.create({
      data: { organizationId, status: "ORDERED", ...createdByFields(actor) },
      select: { id: true, createdAt: true },
    });
    const moved = await tx.clubOrderNeed.updateMany({
      where: { id: { in: moveIds }, organizationId, status: "NEEDED" },
      data: { status: "ORDERED", batchId: batch.id },
    });
    // The club lock makes this impossible for writes that take it; anything
    // else that moved a need in between rolls the whole order back.
    if (moved.count !== moveIds.length) {
      throw new ClubOrderError("ORDER_CHANGED", "The order list changed while placing this order. Reload and try again.");
    }
    const lines = plan.filter((line) => line.quantityOrdered > 0);
    await tx.clubSupplyOrderLine.createMany({
      data: lines.map((line) => ({
        batchId: batch.id,
        itemId: line.item.itemId,
        neededCount: line.needed,
        extraCount: line.extra,
        stockAtOrderTime: line.inStock,
        quantityOrdered: line.quantityOrdered,
      })),
    });
    const totalQuantity = lines.reduce((sum, line) => sum + line.quantityOrdered, 0);
    const who = auditActorFields(actor);
    await writeAuditLog({
      ...who.actorFields,
      action: "CLUB_ORDER_PLACED",
      entityType: "ClubSupplyOrderBatch",
      entityId: batch.id,
      summary: `Placed a club supply order for ${lines.length} item${lines.length === 1 ? "" : "s"}.`,
      metadata: { organizationId, itemCount: lines.length, totalQuantity, needCount: moved.count, ...who.metadata },
    }, tx);
    const orderLines: OrderLine[] = lines.map((line) => ({
      item: line.item,
      needed: line.needed,
      extra: line.extra,
      inStock: line.inStock,
      toOrder: line.quantityOrdered,
      missingCatalogNumber: !line.item.catalogNumber,
    }));
    return { batchId: batch.id, createdAt: batch.createdAt.toISOString(), needCount: moved.count, lines: orderLines };
  });
}

const batchLineSelect = {
  itemId: true, neededCount: true, extraCount: true, stockAtOrderTime: true, quantityOrdered: true, item: { select: itemSelect },
} satisfies Prisma.ClubSupplyOrderLineSelect;

function toBatchOrderLine(line: Prisma.ClubSupplyOrderLineGetPayload<{ select: typeof batchLineSelect }>): OrderLine {
  return {
    item: toCatalogItem(line.item),
    needed: line.neededCount,
    extra: line.extraCount,
    inStock: line.stockAtOrderTime,
    toOrder: line.quantityOrdered,
    missingCatalogNumber: !line.item.catalogNumber,
  };
}

/** One order batch's lines, for the CSV exports and the receiving screen (#487). `toOrder` is what was ordered. */
export async function getOrderBatch(organizationId: string, batchId: string) {
  const batch = await getPrisma().clubSupplyOrderBatch.findFirst({
    where: { id: batchId, organizationId },
    select: { id: true, status: true, createdAt: true, receivedAt: true, lines: { select: batchLineSelect } },
  });
  if (!batch) throw new ClubOrderError("BATCH_NOT_FOUND", "That order could not be found.");
  const lines = batch.lines.map(toBatchOrderLine).sort((a, b) => a.item.name.localeCompare(b.item.name));
  return { id: batch.id, status: batch.status, createdAt: batch.createdAt.toISOString(), receivedAt: batch.receivedAt?.toISOString() ?? null, lines };
}

/**
 * Marks an order received (#487). The batch flips ORDERED to RECEIVED with a
 * guarded update first; if nothing flipped it was already received (or isn't
 * this club's), and stock is never touched. Then exactly each line's
 * `quantityOrdered` joins the club's stock, and the batch's ORDERED needs
 * move to RECEIVED, reserved for their person until awarded.
 */
export async function markOrderBatchReceived(organizationId: string, batchId: string, actor: ClubOrderActor) {
  return getPrisma().$transaction(async (tx) => {
    await lockClubOrders(tx, organizationId);
    const receivedAt = new Date();
    const flipped = await tx.clubSupplyOrderBatch.updateMany({
      where: { id: batchId, organizationId, status: "ORDERED" },
      data: { status: "RECEIVED", receivedAt, ...receivedByFields(actor) },
    });
    if (flipped.count === 0) {
      const exists = await tx.clubSupplyOrderBatch.findFirst({ where: { id: batchId, organizationId }, select: { id: true } });
      if (!exists) throw new ClubOrderError("BATCH_NOT_FOUND", "That order could not be found.");
      throw new ClubOrderError("ALREADY_RECEIVED", "That order was already marked received.");
    }
    const batch = await tx.clubSupplyOrderBatch.findUniqueOrThrow({
      where: { id: batchId },
      select: { id: true, createdAt: true, lines: { select: batchLineSelect } },
    });
    for (const line of batch.lines) {
      if (line.quantityOrdered <= 0) continue;
      await tx.clubSupplyStock.upsert({
        where: { organizationId_itemId: { organizationId, itemId: line.itemId } },
        create: { organizationId, itemId: line.itemId, quantityOnHand: line.quantityOrdered },
        update: { quantityOnHand: { increment: line.quantityOrdered } },
      });
    }
    const needs = await tx.clubOrderNeed.updateMany({
      where: { organizationId, batchId: batch.id, status: "ORDERED" },
      data: { status: "RECEIVED" },
    });
    const totalQuantity = batch.lines.reduce((sum, line) => sum + line.quantityOrdered, 0);
    const who = auditActorFields(actor);
    await writeAuditLog({
      ...who.actorFields,
      action: "CLUB_ORDER_RECEIVED",
      entityType: "ClubSupplyOrderBatch",
      entityId: batch.id,
      summary: `Marked a club supply order received: ${totalQuantity} unit${totalQuantity === 1 ? "" : "s"} added to stock.`,
      metadata: { organizationId, itemCount: batch.lines.length, totalQuantity, needCount: needs.count, ...who.metadata },
    }, tx);
    return {
      id: batch.id,
      status: "RECEIVED" as const,
      createdAt: batch.createdAt.toISOString(),
      receivedAt: receivedAt.toISOString(),
      lines: batch.lines.map(toBatchOrderLine),
    };
  });
}

/** Takes `count` units off one item's stock in SQL, floored at zero: never a read-then-write. */
async function decrementStock(tx: Prisma.TransactionClient, organizationId: string, itemId: string, count: number) {
  if (count <= 0) return;
  await tx.$executeRaw`
    UPDATE "ClubSupplyStock"
    SET "quantityOnHand" = GREATEST(0, "quantityOnHand" - ${count}::int), "updatedAt" = CURRENT_TIMESTAMP
    WHERE "organizationId" = ${organizationId} AND "itemId" = ${itemId}`;
}

/**
 * Marks needs awarded (handed out) (#487). A RECEIVED need draws down the
 * unit that arrived for it; a NEEDED need may be handed out "from stock"
 * when available stock covers it (refused as NOT_ENOUGH_STOCK otherwise).
 * Each status change is a guarded update, stock moves in SQL by exactly the
 * number of needs that actually moved, and one audit row records the counts,
 * so a double tap or two directors at once never count a need twice. Needs
 * already awarded, still on order, or with no catalog item are left alone.
 */
export async function markNeedsAwarded(organizationId: string, needIds: readonly string[], actor: ClubOrderActor) {
  return getPrisma().$transaction(async (tx) => {
    await lockClubOrders(tx, organizationId);
    const needs = await tx.clubOrderNeed.findMany({
      where: { id: { in: [...needIds] }, organizationId, status: { in: ["RECEIVED", "NEEDED"] }, itemId: { not: null } },
      select: { id: true, itemId: true, status: true, item: { select: { name: true } } },
    });
    const byItem = groupByItem(needs);
    const available = await availableByItem(tx, organizationId, [...byItem.keys()]);
    for (const [itemId, group] of byItem) {
      const fromStock = group.filter((need) => need.status === "NEEDED").length;
      if (fromStock > (available.get(itemId) ?? 0)) {
        throw new ClubOrderError(
          "NOT_ENOUGH_STOCK",
          `Not enough ${group[0].item!.name} in stock to hand out ${fromStock}. Order more, or update the stock count.`,
        );
      }
    }
    let received = 0;
    let fromStock = 0;
    const itemCounts: Record<string, number> = {};
    for (const [itemId, group] of byItem) {
      const receivedMoved = await tx.clubOrderNeed.updateMany({
        where: { id: { in: group.filter((need) => need.status === "RECEIVED").map((need) => need.id) }, organizationId, status: "RECEIVED" },
        data: { status: "AWARDED" },
      });
      const stockMoved = await tx.clubOrderNeed.updateMany({
        where: { id: { in: group.filter((need) => need.status === "NEEDED").map((need) => need.id) }, organizationId, status: "NEEDED" },
        data: { status: "AWARDED" },
      });
      const moved = receivedMoved.count + stockMoved.count;
      await decrementStock(tx, organizationId, itemId, moved);
      received += receivedMoved.count;
      fromStock += stockMoved.count;
      if (moved > 0) itemCounts[itemId] = moved;
    }
    const awarded = received + fromStock;
    if (awarded === 0) return { awarded: 0, fromStock: 0 };
    const who = auditActorFields(actor);
    await writeAuditLog({
      ...who.actorFields,
      action: "CLUB_ORDER_AWARDED",
      entityType: "ClubOrderNeed",
      summary: `Marked ${awarded} club supply need${awarded === 1 ? "" : "s"} awarded${fromStock > 0 ? `, ${fromStock} from stock` : ""}.`,
      metadata: { organizationId, needCount: awarded, receivedCount: received, fromStockCount: fromStock, itemCounts, ...who.metadata },
    }, tx);
    return { awarded, fromStock };
  });
}

/**
 * "Already handed out" (#487): for honors a club gave out before it ordered
 * here (or got some other way). Moves the selected NEEDED needs straight to
 * AWARDED without touching stock, and records one audit row with the count.
 * Never automatic: only the needs a director or deputy picked.
 */
export async function markNeedsAlreadyAwarded(organizationId: string, needIds: readonly string[], actor: ClubOrderActor) {
  return getPrisma().$transaction(async (tx) => {
    await lockClubOrders(tx, organizationId);
    const moved = await tx.clubOrderNeed.updateMany({
      where: { id: { in: [...needIds] }, organizationId, status: "NEEDED" },
      data: { status: "AWARDED" },
    });
    if (moved.count === 0) return { marked: 0 };
    const who = auditActorFields(actor);
    await writeAuditLog({
      ...who.actorFields,
      action: "CLUB_ORDER_MARKED_ALREADY_AWARDED",
      entityType: "ClubOrderNeed",
      summary: `Marked ${moved.count} club supply need${moved.count === 1 ? "" : "s"} as already handed out.`,
      metadata: { organizationId, needCount: moved.count, ...who.metadata },
    }, tx);
    return { marked: moved.count };
  });
}

export type OrderBatchSummary = {
  id: string;
  status: "ORDERED" | "RECEIVED";
  createdAt: string;
  receivedAt: string | null;
  itemCount: number;
  totalQuantity: number;
  lines: Array<{ itemId: string; name: string; catalogNumber: string | null; neededCount: number; extraCount: number; quantityOrdered: number }>;
};

/** Every order this club has placed, most recent first (#487): the order screen's history and "Mark received". */
export async function listOrderBatches(organizationId: string): Promise<OrderBatchSummary[]> {
  const batches = await getPrisma().clubSupplyOrderBatch.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, status: true, createdAt: true, receivedAt: true,
      lines: { select: { itemId: true, neededCount: true, extraCount: true, quantityOrdered: true, item: { select: { name: true, catalogNumber: true } } } },
    },
  });
  return batches.map((batch) => ({
    id: batch.id,
    status: batch.status,
    createdAt: batch.createdAt.toISOString(),
    receivedAt: batch.receivedAt?.toISOString() ?? null,
    itemCount: batch.lines.length,
    totalQuantity: batch.lines.reduce((sum, line) => sum + line.quantityOrdered, 0),
    lines: batch.lines.map((line) => ({
      itemId: line.itemId, name: line.item.name, catalogNumber: line.item.catalogNumber,
      neededCount: line.neededCount, extraCount: line.extraCount, quantityOrdered: line.quantityOrdered,
    })),
  }));
}

async function namesFor(personIds: Iterable<string>) {
  const ids = [...new Set(personIds)];
  if (ids.length === 0) return new Map<string, { firstName: string; lastName: string }>();
  const people = await getPrisma().person.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true } });
  return new Map(people.map((person) => [person.id, { firstName: person.firstName, lastName: person.lastName }]));
}

const byItemThenName = <T extends { itemName: string; firstName: string; lastName: string }>(a: T, b: T) =>
  a.itemName.localeCompare(b.itemName) || a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName);

export type AwardableNeed = { needId: string; itemId: string; itemName: string; firstName: string; lastName: string; fromStock: boolean };

async function awardableFrom(organizationId: string, picture: NeededPicture): Promise<AwardableNeed[]> {
  const received = await getPrisma().clubOrderNeed.findMany({
    where: { organizationId, status: "RECEIVED", itemId: { not: null } },
    select: { id: true, personId: true, itemId: true, item: { select: { name: true } } },
  });
  const fromStock = picture.needs.filter((need) => picture.fromStock.has(need.id));
  const names = await namesFor([...received, ...fromStock].map((need) => need.personId));
  const row = (need: { id: string; personId: string; itemId: string | null; item: { name: string } | null }, isFromStock: boolean): AwardableNeed => ({
    needId: need.id,
    itemId: need.itemId!,
    itemName: need.item!.name,
    firstName: names.get(need.personId)?.firstName ?? "",
    lastName: names.get(need.personId)?.lastName ?? "",
    fromStock: isFromStock,
  });
  return [...received.map((need) => row(need, false)), ...fromStock.map((need) => row(need, true))].sort(byItemThenName);
}

/**
 * Ready to hand out (#487): RECEIVED needs, plus NEEDED needs that available
 * stock already covers (`fromStock`). One row per person per item, names and
 * the item only — nothing else about the person ever reaches this list.
 */
export async function listAwardableNeeds(organizationId: string): Promise<AwardableNeed[]> {
  return awardableFrom(organizationId, await neededPicture(organizationId));
}

export type WaitingNeed = {
  needId: string;
  /** Where the need came from: only honors get the "completed before you started ordering" prompt (#497). */
  sourceType: "HONOR" | "UNIFORM";
  itemName: string | null;
  sourceLabel: string;
  sourceDate: string;
  firstName: string;
  lastName: string;
  /** Recorded before this club's first order here (or no order yet): maybe handed out long ago. */
  beforeFirstOrder: boolean;
};

async function waitingFrom(picture: NeededPicture, firstOrderAt: Date | null): Promise<WaitingNeed[]> {
  const names = await namesFor(picture.needs.map((need) => need.personId));
  return picture.needs
    .map((need) => ({
      needId: need.id,
      sourceType: need.sourceType,
      itemName: need.item?.name ?? null,
      sourceLabel: need.sourceLabel,
      sourceDate: need.sourceDate,
      firstName: names.get(need.personId)?.firstName ?? "",
      lastName: names.get(need.personId)?.lastName ?? "",
      beforeFirstOrder: firstOrderAt === null || need.createdAt < firstOrderAt,
    }))
    .sort((a, b) => byItemThenName({ ...a, itemName: a.itemName ?? a.sourceLabel }, { ...b, itemName: b.itemName ?? b.sourceLabel }));
}

/**
 * Everything the order screen shows at once (#487): the order list, past
 * orders, who's ready to hand out, and who's still waiting (NEEDED), with
 * the date of the club's first order so the screen can offer "Already handed
 * out" for honors completed before ordering started here. Reads only: an
 * editor's visit syncs needs first (`modules/honors/order-source.ts`); a
 * view-only visit sees what's on file.
 */
export async function loadOrderWorkspace(organizationId: string) {
  const [picture, batches] = await Promise.all([neededPicture(organizationId), listOrderBatches(organizationId)]);
  const firstOrder = batches.at(-1)?.createdAt ?? null;
  const { lines, unmatched } = orderListFrom(picture, new Map());
  const [awardable, waiting] = await Promise.all([
    awardableFrom(organizationId, picture),
    waitingFrom(picture, firstOrder ? new Date(firstOrder) : null),
  ]);
  return { lines, unmatched, batches, awardable, waiting, firstOrderAt: firstOrder };
}

/** The pick list's item and size columns for a catalog row: a uniform's size is split off its name (#497). */
function pickItem(item: { name: string; section: string }) {
  const { itemName, size } = itemAndSize(item);
  return { itemName, size };
}

/**
 * The per-member pick list (#487, #497): names, the item, its size, and where it stands.
 * For one batch: that order's needs still to hand out (Ordered, or Ready to
 * hand out). Without a batch: who is currently to order (NEEDED, labelled
 * "To order", or "Ready to hand out (from stock)" when stock covers it) and
 * who is ready to hand out (RECEIVED).
 */
export async function listPickList(organizationId: string, batchId?: string): Promise<PickListEntry[]> {
  if (batchId) {
    const needs = await getPrisma().clubOrderNeed.findMany({
      where: { organizationId, batchId, status: { in: ["ORDERED", "RECEIVED"] }, itemId: { not: null } },
      select: { personId: true, status: true, item: { select: { name: true, section: true } } },
    });
    const names = await namesFor(needs.map((need) => need.personId));
    return needs.map((need) => ({
      lastName: names.get(need.personId)?.lastName ?? "",
      firstName: names.get(need.personId)?.firstName ?? "",
      ...pickItem(need.item!),
      status: need.status === "RECEIVED" ? "Ready to hand out" : "Ordered",
    }));
  }
  const picture = await neededPicture(organizationId);
  const received = await getPrisma().clubOrderNeed.findMany({
    where: { organizationId, status: "RECEIVED", itemId: { not: null } },
    select: { personId: true, item: { select: { name: true, section: true } } },
  });
  const matchedNeeded = picture.needs.filter((need) => need.itemId !== null);
  const names = await namesFor([...matchedNeeded, ...received].map((need) => need.personId));
  const entry = (personId: string, item: { name: string; section: string }, status: PickListEntry["status"]): PickListEntry => ({
    lastName: names.get(personId)?.lastName ?? "",
    firstName: names.get(personId)?.firstName ?? "",
    ...pickItem(item),
    status,
  });
  return [
    ...matchedNeeded.map((need) => entry(need.personId, need.item!, picture.fromStock.has(need.id) ? "Ready to hand out (from stock)" : "To order")),
    ...received.map((need) => entry(need.personId, need.item!, "Ready to hand out")),
  ];
}
