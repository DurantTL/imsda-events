import { honorCategoryForSection, type ClubSupplySection } from "@/modules/club-supplies/domain";
import { isUniformSection, itemAndSize } from "@/modules/uniforms/domain";
import { toCsv } from "@/modules/reporting/csv";

/**
 * Club order fulfillment (#487): pure rules for turning a club's open needs
 * (from honors and uniforms today, earned awards later, #532) into
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
 * The oldest need first (#790): by source date, createdAt, then id. A need
 * with no date (a completion recorded without one) sorts last, so it never
 * jumps the queue for stock ahead of needs whose date is known. Stable, and
 * the input is not changed.
 */
export function sortNeedsOldestFirst<T extends { sourceDate: string; createdAt: Date; id: string }>(needs: readonly T[]): T[] {
  return [...needs].sort((a, b) => {
    if (Boolean(a.sourceDate) !== Boolean(b.sourceDate)) return a.sourceDate ? -1 : 1;
    if (a.sourceDate !== b.sourceDate) return a.sourceDate < b.sourceDate ? -1 : 1;
    return a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
  });
}

/**
 * The "completed before" bulk selection on the order screen (#790): needs
 * whose date is strictly before `beforeDate`. An undated need is never
 * "before" any date, so it is only picked up by Select all, never by accident.
 */
export function needsDatedBefore<T extends { sourceDate: string }>(needs: readonly T[], beforeDate: string): T[] {
  if (!beforeDate) return [];
  return needs.filter((need) => Boolean(need.sourceDate) && need.sourceDate < beforeDate);
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

export type PickListEntry = {
  lastName: string;
  firstName: string;
  itemName: string;
  /** A uniform's size ("M", "Size 8"); blank for items without one, like honor patches (#497). */
  size: string;
  status: PickListStatus;
};

/**
 * The per-member pick list (#487, #497): names, the item, its size (uniforms),
 * and where it stands, so it can be printed and handed to whoever gives out
 * patches and uniforms. No birth date, contact, guardian, or medical field
 * ever reaches this shape.
 */
export function pickListCsv(entries: readonly PickListEntry[]) {
  const rows: Array<Array<string | number>> = [["Last name", "First name", "Item", "Size", "Status"]];
  const sorted = [...entries].sort((a, b) =>
    a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName) || a.itemName.localeCompare(b.itemName));
  for (const entry of sorted) rows.push([entry.lastName, entry.firstName, entry.itemName, entry.size, entry.status]);
  return toCsv(rows);
}

/**
 * The order helper list (#654): a planning aid, not an order form. Lines are
 * grouped Uniforms, then Honors, then other supplies and insignia, and each
 * line is one catalog item (a sized item is one line per size, each with its
 * own item number).
 */
export const ORDER_LIST_SECTIONS = ["UNIFORMS", "HONORS", "OTHER"] as const;
export type OrderListSection = (typeof ORDER_LIST_SECTIONS)[number];

export const orderListSectionLabels: Record<OrderListSection, string> = {
  UNIFORMS: "Uniforms",
  HONORS: "Honors",
  OTHER: "Other supplies and insignia",
};

/** Which helper-list section a catalog section belongs to. */
export function orderListSectionFor(section: string): OrderListSection {
  if (section === "TEEN_LEADERSHIP_TRAINING") return "OTHER";
  if (isUniformSection(section)) return "UNIFORMS";
  return honorCategoryForSection(section as ClubSupplySection) ? "HONORS" : "OTHER";
}

export type HelperCatalogItem = {
  itemId: string;
  section: string;
  name: string;
  catalogNumber: string | null;
  sizeLabel: string | null;
};

export type HelperLine = {
  itemId: string;
  section: OrderListSection;
  /** The item's name without its size (a uniform's size is split off). */
  name: string;
  size: string;
  catalogNumber: string | null;
  /** What honors, uniforms and awards call for. */
  computedNeeded: number;
  /** Quantity on the list: the director's edit when there is one, else `computedNeeded`. */
  needed: number;
  /** A director changed this line (quantity, or added it). */
  edited: boolean;
  onHand: number;
  /** Needed less on hand, never below zero. */
  toOrder: number;
};

/**
 * The helper list's lines. `overrideByItem` holds a director's quantity per
 * item (0 takes it off the list). Lines are ordered by section, then name,
 * then size. A line with `needed` 0 is "removed": shown so it can be put back,
 * never exported.
 */
export function buildHelperLines(
  items: readonly HelperCatalogItem[],
  computedByItem: ReadonlyMap<string, number>,
  overrideByItem: ReadonlyMap<string, number>,
  onHandByItem: ReadonlyMap<string, number>,
): HelperLine[] {
  return items
    .map((item): HelperLine => {
      const parts = itemAndSize(item);
      const computedNeeded = computedByItem.get(item.itemId) ?? 0;
      const override = overrideByItem.get(item.itemId);
      const needed = override ?? computedNeeded;
      const onHand = onHandByItem.get(item.itemId) ?? 0;
      return {
        itemId: item.itemId,
        section: orderListSectionFor(item.section),
        name: parts.itemName,
        size: parts.size || item.sizeLabel || "",
        catalogNumber: item.catalogNumber,
        computedNeeded,
        needed,
        edited: override !== undefined,
        onHand,
        toOrder: Math.max(0, needed - onHand),
      };
    })
    .sort((a, b) =>
      ORDER_LIST_SECTIONS.indexOf(a.section) - ORDER_LIST_SECTIONS.indexOf(b.section)
      || a.name.localeCompare(b.name) || a.size.localeCompare(b.size, undefined, { numeric: true }));
}

/** Lines that are on the list (quantity above zero). */
export const activeHelperLines = (lines: readonly HelperLine[]) => lines.filter((line) => line.needed > 0);

export type OrderExportHeader = {
  clubName: string;
  church: string;
  directorName: string;
  directorEmail: string;
  directorPhone: string;
  /** Calendar date shown on the export, `YYYY-MM-DD`. */
  date: string;
};

/**
 * The export (#654): club name, church, director contact and date, then every
 * line grouped by section with item name, size, item number, quantity, what honors, uniforms and awards calculated, what is
 * available (in stock minus items set aside for someone) and to order. Not an AdventSource file: it is a list to order from.
 */
export function orderListCsv(header: OrderExportHeader, lines: readonly HelperLine[]) {
  const rows: Array<Array<string | number>> = [
    ["Club", header.clubName],
    ["Church", header.church],
    ["Director", header.directorName],
    ["Director email", header.directorEmail],
    ["Director phone", header.directorPhone],
    ["Date", header.date],
    [],
    ["Section", "Item name", "Size", "Item number", "Quantity needed", "Calculated", "Available", "To order"],
  ];
  const active = activeHelperLines(lines);
  for (const section of ORDER_LIST_SECTIONS) {
    for (const line of active.filter((entry) => entry.section === section)) {
      rows.push([orderListSectionLabels[section], line.name, line.size, line.catalogNumber ?? "", line.needed, line.computedNeeded, line.onHand, line.toOrder]);
    }
  }
  return toCsv(rows);
}
