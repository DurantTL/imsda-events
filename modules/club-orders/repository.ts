import "server-only";

import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { buildOrderLines, type OrderCatalogItem, type OrderLine, type PickListEntry } from "@/modules/club-orders/domain";
import type { ClubSupplyStockActor } from "@/modules/club-supplies/repository";

/**
 * Club order fulfillment storage (#487): a reusable order and stock layer
 * keyed on `ClubSupplyItem` (#531). It knows nothing about where a need came
 * from — a caller (`modules/honors/order-source.ts` today) hands it need
 * candidates keyed by `sourceType`/`sourceId`, and this module tracks each
 * one from NEEDED through ORDERED, RECEIVED, and AWARDED, moving
 * `ClubSupplyStock` (#531) along the way.
 */

export type ClubOrderActor = ClubSupplyStockActor;

export type ClubOrderErrorCode = "NOTHING_TO_ORDER" | "BATCH_NOT_FOUND" | "ALREADY_RECEIVED";

export class ClubOrderError extends Error {
  constructor(public readonly code: ClubOrderErrorCode, message: string) {
    super(message);
    this.name = "ClubOrderError";
  }
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

function auditActorFields(actor: ClubOrderActor) {
  return {
    actorFields: "userId" in actor ? { actorUserId: actor.userId } : {},
    metadata: "accountId" in actor ? { actorAttendeeAccountId: actor.accountId } : { actAsId: actor.actAsId },
  };
}

export type NeedCandidate = { sourceId: string; personId: string; itemId: string | null };

/**
 * Records new needs from one source (#487), skipping any `sourceId` this
 * source has already recorded (the unique `[sourceType, sourceId]` index).
 * Safe to call on every visit to the order screen: a completion already on
 * file creates nothing new, so only genuinely new completions ever show up as
 * NEEDED, with no manual comparison against a prior file.
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
    })),
    skipDuplicates: true,
  });
}

const itemSelect = { id: true, name: true, catalogNumber: true } satisfies Prisma.ClubSupplyItemSelect;

function toCatalogItem(item: { id: string; name: string; catalogNumber: string | null }): OrderCatalogItem {
  return { itemId: item.id, name: item.name, catalogNumber: item.catalogNumber };
}

export type UnmatchedNeed = { sourceId: string; personId: string };

/**
 * The order screen's data (#487): one line per catalog item with an open
 * need, extras applied, stock subtracted, never below zero. Needs whose
 * honor has no matching catalog item at all (not merely no number) come back
 * separately as `unmatched`, so they're flagged rather than silently dropped.
 */
export async function listOrderList(
  organizationId: string,
  extraByItem: ReadonlyMap<string, number> = new Map(),
): Promise<{ lines: OrderLine[]; unmatched: UnmatchedNeed[] }> {
  const needs = await getPrisma().clubOrderNeed.findMany({
    where: { organizationId, status: "NEEDED" },
    select: { sourceId: true, personId: true, itemId: true },
  });
  const matched = needs.filter((need): need is typeof need & { itemId: string } => need.itemId !== null);
  const unmatched: UnmatchedNeed[] = needs
    .filter((need) => need.itemId === null)
    .map((need) => ({ sourceId: need.sourceId, personId: need.personId }));
  const itemIds = [...new Set([...matched.map((need) => need.itemId), ...extraByItem.keys()])];
  if (itemIds.length === 0) return { lines: [], unmatched };
  const [items, stock] = await Promise.all([
    getPrisma().clubSupplyItem.findMany({ where: { id: { in: itemIds } }, select: itemSelect }),
    getPrisma().clubSupplyStock.findMany({ where: { organizationId, itemId: { in: itemIds } }, select: { itemId: true, quantityOnHand: true } }),
  ]);
  const neededByItem = new Map<string, number>();
  for (const need of matched) neededByItem.set(need.itemId, (neededByItem.get(need.itemId) ?? 0) + 1);
  const stockByItem = new Map(stock.map((row) => [row.itemId, row.quantityOnHand]));
  const lines = buildOrderLines(items.map(toCatalogItem), neededByItem, stockByItem, extraByItem);
  return { lines, unmatched };
}

/**
 * Places an order (#487): recomputes the order list inside the transaction
 * (so a need recorded a moment ago is included), creates one order line per
 * item with something to order, and moves every currently-NEEDED need for
 * those items to ORDERED. Items with nothing to order (extras only, already
 * covered by stock) are left out of the batch entirely.
 */
export async function createOrderBatch(organizationId: string, extras: Record<string, number>, actor: ClubOrderActor) {
  const extraByItem = new Map(Object.entries(extras).filter(([, value]) => value > 0));
  return getPrisma().$transaction(async (tx) => {
    const needs = await tx.clubOrderNeed.findMany({
      where: { organizationId, status: "NEEDED", itemId: { not: null } },
      select: { id: true, itemId: true },
    });
    const neededByItem = new Map<string, number>();
    for (const need of needs) neededByItem.set(need.itemId!, (neededByItem.get(need.itemId!) ?? 0) + 1);
    const itemIds = [...new Set([...neededByItem.keys(), ...extraByItem.keys()])];
    if (itemIds.length === 0) throw new ClubOrderError("NOTHING_TO_ORDER", "There's nothing to order right now.");
    const [items, stock] = await Promise.all([
      tx.clubSupplyItem.findMany({ where: { id: { in: itemIds } }, select: itemSelect }),
      tx.clubSupplyStock.findMany({ where: { organizationId, itemId: { in: itemIds } }, select: { itemId: true, quantityOnHand: true } }),
    ]);
    const stockByItem = new Map(stock.map((row) => [row.itemId, row.quantityOnHand]));
    const lines = buildOrderLines(items.map(toCatalogItem), neededByItem, stockByItem, extraByItem).filter((line) => line.toOrder > 0);
    if (lines.length === 0) throw new ClubOrderError("NOTHING_TO_ORDER", "There's nothing to order right now.");

    const batch = await tx.clubSupplyOrderBatch.create({
      data: { organizationId, status: "ORDERED", ...createdByFields(actor) },
      select: { id: true, createdAt: true },
    });
    await tx.clubSupplyOrderLine.createMany({
      data: lines.map((line) => ({
        batchId: batch.id,
        itemId: line.item.itemId,
        neededCount: line.needed,
        extraCount: line.extra,
        stockAtOrderTime: line.inStock,
      })),
    });
    const orderedItemIds = lines.map((line) => line.item.itemId);
    await tx.clubOrderNeed.updateMany({
      where: { organizationId, status: "NEEDED", itemId: { in: orderedItemIds } },
      data: { status: "ORDERED", batchId: batch.id },
    });
    const who = auditActorFields(actor);
    await writeAuditLog({
      ...who.actorFields,
      action: "CLUB_ORDER_PLACED",
      entityType: "ClubSupplyOrderBatch",
      entityId: batch.id,
      summary: `Placed a club supply order for ${lines.length} item${lines.length === 1 ? "" : "s"}.`,
      metadata: {
        organizationId,
        itemCount: lines.length,
        totalQuantity: lines.reduce((sum, line) => sum + line.toOrder, 0),
        ...who.metadata,
      },
    }, tx);
    return { batchId: batch.id, createdAt: batch.createdAt.toISOString(), lines };
  });
}

/** One order batch's lines, for the CSV exports and the receiving screen (#487). */
export async function getOrderBatch(organizationId: string, batchId: string) {
  const batch = await getPrisma().clubSupplyOrderBatch.findFirst({
    where: { id: batchId, organizationId },
    select: {
      id: true, status: true, createdAt: true, receivedAt: true,
      lines: { select: { itemId: true, neededCount: true, extraCount: true, stockAtOrderTime: true, item: { select: itemSelect } } },
    },
  });
  if (!batch) throw new ClubOrderError("BATCH_NOT_FOUND", "That order could not be found.");
  const lines: OrderLine[] = batch.lines.map((line) => ({
    item: toCatalogItem(line.item),
    needed: line.neededCount,
    extra: line.extraCount,
    inStock: line.stockAtOrderTime,
    toOrder: line.neededCount + line.extraCount,
    missingCatalogNumber: !line.item.catalogNumber,
  }));
  return { id: batch.id, status: batch.status, createdAt: batch.createdAt.toISOString(), receivedAt: batch.receivedAt?.toISOString() ?? null, lines };
}

/**
 * Marks an order received (#487): the full ordered quantity of every line
 * (needed plus extras) is added to the club's stock, and every need that
 * order covers moves from ORDERED to RECEIVED, ready to be awarded. Stock
 * gains the whole quantity rather than only the extras, because who
 * specifically gets which unit is decided later, at awarding.
 */
export async function markOrderBatchReceived(organizationId: string, batchId: string, actor: ClubOrderActor) {
  return getPrisma().$transaction(async (tx) => {
    const batch = await tx.clubSupplyOrderBatch.findFirst({
      where: { id: batchId, organizationId },
      select: { id: true, status: true, createdAt: true, lines: { select: { itemId: true, neededCount: true, extraCount: true, item: { select: itemSelect } } } },
    });
    if (!batch) throw new ClubOrderError("BATCH_NOT_FOUND", "That order could not be found.");
    if (batch.status === "RECEIVED") throw new ClubOrderError("ALREADY_RECEIVED", "That order was already marked received.");
    for (const line of batch.lines) {
      const quantity = line.neededCount + line.extraCount;
      await tx.clubSupplyStock.upsert({
        where: { organizationId_itemId: { organizationId, itemId: line.itemId } },
        create: { organizationId, itemId: line.itemId, quantityOnHand: quantity },
        update: { quantityOnHand: { increment: quantity } },
      });
    }
    await tx.clubOrderNeed.updateMany({
      where: { organizationId, batchId: batch.id, status: "ORDERED" },
      data: { status: "RECEIVED" },
    });
    await tx.clubSupplyOrderBatch.update({
      where: { id: batch.id },
      data: { status: "RECEIVED", receivedAt: new Date(), ...receivedByFields(actor) },
    });
    const who = auditActorFields(actor);
    await writeAuditLog({
      ...who.actorFields,
      action: "CLUB_ORDER_RECEIVED",
      entityType: "ClubSupplyOrderBatch",
      entityId: batch.id,
      summary: `Marked a club supply order received: ${batch.lines.length} item${batch.lines.length === 1 ? "" : "s"} added to stock.`,
      metadata: {
        organizationId,
        itemCount: batch.lines.length,
        totalQuantity: batch.lines.reduce((sum, line) => sum + line.neededCount + line.extraCount, 0),
        ...who.metadata,
      },
    }, tx);
    const receivedLines: OrderLine[] = batch.lines.map((line) => ({
      item: toCatalogItem(line.item),
      needed: line.neededCount,
      extra: line.extraCount,
      inStock: line.neededCount + line.extraCount,
      toOrder: line.neededCount + line.extraCount,
      missingCatalogNumber: !line.item.catalogNumber,
    }));
    return { id: batch.id, status: "RECEIVED" as const, createdAt: batch.createdAt.toISOString(), receivedAt: new Date().toISOString(), lines: receivedLines };
  });
}

/**
 * Awards a group of received needs (#487): each one takes one unit off the
 * club's stock for its item, floored at zero, and moves to AWARDED. Needs
 * that aren't RECEIVED (already awarded, or never ordered) are left alone
 * rather than guessed at.
 */
export async function markNeedsAwarded(organizationId: string, needIds: readonly string[], actor: ClubOrderActor) {
  return getPrisma().$transaction(async (tx) => {
    const needs = await tx.clubOrderNeed.findMany({
      where: { id: { in: [...needIds] }, organizationId, status: "RECEIVED", itemId: { not: null } },
      select: { id: true, itemId: true },
    });
    if (needs.length === 0) return { awarded: 0 };
    const countByItem = new Map<string, number>();
    for (const need of needs) countByItem.set(need.itemId!, (countByItem.get(need.itemId!) ?? 0) + 1);
    for (const [itemId, count] of countByItem) {
      const stock = await tx.clubSupplyStock.findUnique({ where: { organizationId_itemId: { organizationId, itemId } }, select: { quantityOnHand: true } });
      const nextQuantity = Math.max(0, (stock?.quantityOnHand ?? 0) - count);
      await tx.clubSupplyStock.upsert({
        where: { organizationId_itemId: { organizationId, itemId } },
        create: { organizationId, itemId, quantityOnHand: nextQuantity },
        update: { quantityOnHand: nextQuantity },
      });
    }
    await tx.clubOrderNeed.updateMany({ where: { id: { in: needs.map((need) => need.id) } }, data: { status: "AWARDED" } });
    const who = auditActorFields(actor);
    await writeAuditLog({
      ...who.actorFields,
      action: "CLUB_ORDER_AWARDED",
      entityType: "ClubOrderNeed",
      summary: `Marked ${needs.length} club supply need${needs.length === 1 ? "" : "s"} awarded.`,
      metadata: {
        organizationId,
        needCount: needs.length,
        itemCounts: Object.fromEntries(countByItem),
        ...who.metadata,
      },
    }, tx);
    return { awarded: needs.length };
  });
}

/**
 * The per-member pick list (#487): names and honors only, for needs that have
 * an order placed against them (ORDERED or RECEIVED, not yet AWARDED).
 * Restricted to one batch when given, for "who gets which patch when this
 * order arrives".
 */
export async function listPickList(organizationId: string, batchId?: string): Promise<PickListEntry[]> {
  const needs = await getPrisma().clubOrderNeed.findMany({
    where: {
      organizationId,
      status: { in: ["ORDERED", "RECEIVED"] },
      ...(batchId ? { batchId } : {}),
      itemId: { not: null },
    },
    select: { personId: true, item: { select: { name: true } } },
  });
  if (needs.length === 0) return [];
  const people = await getPrisma().person.findMany({
    where: { id: { in: [...new Set(needs.map((need) => need.personId))] } },
    select: { id: true, firstName: true, lastName: true },
  });
  const byId = new Map(people.map((person) => [person.id, person]));
  return needs.map((need) => {
    const person = byId.get(need.personId);
    return { lastName: person?.lastName ?? "", firstName: person?.firstName ?? "", itemName: need.item!.name };
  });
}
