import { toCsv } from "@/modules/reporting/csv";

/**
 * Club order fulfillment (#487): pure rules for turning a club's open needs
 * (from honors today; uniforms and earned awards later, #497 and #532) into
 * an AdventSource order, and for the exports the order screen offers. Every
 * count here is keyed to a `ClubSupplyItem` (#531) — this module never knows
 * where a need came from.
 */

export type OrderCatalogItem = {
  itemId: string;
  name: string;
  catalogNumber: string | null;
};

/**
 * One catalog item's line on the order screen: what's needed, the stock free
 * to cover it, and what to order. `inStock` is *available* stock — on hand
 * less units already received for someone and not yet handed out
 * (`availableStock`) — so a received-but-unawarded patch is never counted
 * twice. For a placed order, `toOrder` is the quantity actually ordered.
 */
export type OrderLine = {
  item: OrderCatalogItem;
  needed: number;
  extra: number;
  inStock: number;
  toOrder: number;
  /** No AdventSource catalog number: can't go on the AdventSource export. */
  missingCatalogNumber: boolean;
};

/**
 * Stock free to cover new needs (#487): on hand, less the units already
 * received for a specific person and not yet handed out (RECEIVED needs).
 * Never below zero, even when a hand-edited stock count (#531) is lower than
 * what's been received.
 */
export function availableStock(onHand: number, reservedForReceived: number) {
  return Math.max(0, onHand - reservedForReceived);
}

/** The quantity to put on an order: needed plus extras, less available stock, never below zero. */
export function quantityToOrder(needed: number, extra: number, available: number) {
  return Math.max(0, needed + extra - available);
}

/** A typed-in extras value: a whole number, never negative; anything else counts as zero. */
export function normalizeExtra(value: unknown) {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : 0;
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

/**
 * The order screen's lines: one per item with an open need, "to order" never
 * below zero. `availableByItem` is `availableStock` per item. Items are sorted
 * by name for a stable screen and export order.
 */
export function buildOrderLines(
  items: readonly OrderCatalogItem[],
  neededByItem: ReadonlyMap<string, number>,
  availableByItem: ReadonlyMap<string, number>,
  extraByItem: ReadonlyMap<string, number>,
): OrderLine[] {
  return [...items]
    .map((item): OrderLine => {
      const needed = neededByItem.get(item.itemId) ?? 0;
      const extra = normalizeExtra(extraByItem.get(item.itemId));
      const inStock = availableByItem.get(item.itemId) ?? 0;
      return { item, needed, extra, inStock, toOrder: quantityToOrder(needed, extra, inStock), missingCatalogNumber: !item.catalogNumber };
    })
    .sort((a, b) => a.item.name.localeCompare(b.item.name));
}

/**
 * The screen's extras applied to the order lines (#487). The order screen and
 * the top-level exports both go through this, so the files a director
 * downloads say exactly what the screen shows.
 */
export function applyExtras(lines: readonly OrderLine[], extras: Readonly<Record<string, unknown>>): OrderLine[] {
  return lines.map((line) => {
    const extra = normalizeExtra(extras[line.item.itemId]);
    return { ...line, extra, toOrder: quantityToOrder(line.needed, extra, line.inStock) };
  });
}

/**
 * Splits one item's NEEDED needs (oldest first) into the ones available stock
 * already covers — ready to hand out "from stock" — and the ones that still
 * have to go on an order (#487).
 */
export function splitNeedsByStock<T>(neededOldestFirst: readonly T[], available: number) {
  const covered = Math.min(neededOldestFirst.length, Math.max(0, available));
  return { fromStock: neededOldestFirst.slice(0, covered), toOrder: neededOldestFirst.slice(covered) };
}

/**
 * The AdventSource quick-order CSV (#487): exactly two columns, catalog
 * number and quantity, nothing else. Catalog numbers are text so leading
 * zeros survive; only lines with a number and something to order are
 * included — an item with no catalog number is never exported, only flagged
 * on screen (`OrderLine.missingCatalogNumber`).
 */
export function adventSourceOrderCsv(lines: readonly OrderLine[]) {
  const rows: Array<Array<string | number>> = [["Catalog number", "Quantity"]];
  for (const line of lines) {
    if (!line.item.catalogNumber || line.toOrder <= 0) continue;
    rows.push([line.item.catalogNumber, String(line.toOrder)]);
  }
  return toCsv(rows);
}

/** A readable order list (#487): name, catalog number, and quantity to order. */
export function readableOrderCsv(lines: readonly OrderLine[]) {
  const rows: Array<Array<string | number>> = [["Item", "Catalog number", "Quantity to order", "Needed", "Extra", "In stock"]];
  for (const line of lines) {
    if (line.toOrder <= 0) continue;
    rows.push([
      line.item.name,
      line.item.catalogNumber ?? "No AdventSource number",
      line.toOrder,
      line.needed,
      line.extra,
      line.inStock,
    ]);
  }
  return toCsv(rows);
}

/** Where a pick-list row stands, in words a director hands to whoever gives out patches. */
export type PickListStatus = "To order" | "Ordered" | "Ready to hand out" | "Ready to hand out (from stock)";

export type PickListEntry = { lastName: string; firstName: string; itemName: string; status: PickListStatus };

/**
 * The per-member pick list (#487): names, the item, and where it stands, so
 * it can be printed and handed to whoever distributes patches. No birth date,
 * contact, guardian, or medical field ever reaches this shape.
 */
export function pickListCsv(entries: readonly PickListEntry[]) {
  const rows: Array<Array<string | number>> = [["Last name", "First name", "Item", "Status"]];
  const sorted = [...entries].sort((a, b) =>
    a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName) || a.itemName.localeCompare(b.itemName));
  for (const entry of sorted) rows.push([entry.lastName, entry.firstName, entry.itemName, entry.status]);
  return toCsv(rows);
}
