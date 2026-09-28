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

/** One catalog item's line on the order screen: what's needed, what's on hand, and what to order. */
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
 * The order screen's lines: one per item with an open need, "to order" never
 * below zero. Items are sorted by name for a stable screen and export order.
 */
export function buildOrderLines(
  items: readonly OrderCatalogItem[],
  neededByItem: ReadonlyMap<string, number>,
  stockByItem: ReadonlyMap<string, number>,
  extraByItem: ReadonlyMap<string, number>,
): OrderLine[] {
  return [...items]
    .map((item): OrderLine => {
      const needed = neededByItem.get(item.itemId) ?? 0;
      const extra = Math.max(0, Math.trunc(extraByItem.get(item.itemId) ?? 0));
      const inStock = stockByItem.get(item.itemId) ?? 0;
      const toOrder = Math.max(0, needed + extra - inStock);
      return { item, needed, extra, inStock, toOrder, missingCatalogNumber: !item.catalogNumber };
    })
    .sort((a, b) => a.item.name.localeCompare(b.item.name));
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

export type PickListEntry = { lastName: string; firstName: string; itemName: string };

/**
 * The per-member pick list (#487): names and honors only, so it can be
 * printed and handed to whoever distributes patches. No birth date, contact,
 * guardian, or medical field ever reaches this shape.
 */
export function pickListCsv(entries: readonly PickListEntry[]) {
  const rows: Array<Array<string | number>> = [["Last name", "First name", "Item"]];
  for (const entry of [...entries].sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName))) {
    rows.push([entry.lastName, entry.firstName, entry.itemName]);
  }
  return toCsv(rows);
}
