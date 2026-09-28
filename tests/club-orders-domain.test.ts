import { describe, expect, it } from "vitest";
import {
  adventSourceOrderCsv,
  applyExtras,
  availableStock,
  buildOrderLines,
  pickListCsv,
  readableOrderCsv,
  splitNeedsByStock,
  type OrderCatalogItem,
} from "@/modules/club-orders/domain";
import { parseCsvMatrix } from "@/modules/imports/csv-parser";

/**
 * Club order fulfillment (#487): the order-list math (needed, extras, stock,
 * to order — never below zero) and the exports it feeds. Synthetic data only.
 */

const items: OrderCatalogItem[] = [
  { itemId: "item-knots", name: "Knot Tying", catalogNumber: "002120" },
  { itemId: "item-camping", name: "Camping Skills", catalogNumber: "000450" },
  { itemId: "item-no-number", name: "Wilderness Living", catalogNumber: null },
];

describe("buildOrderLines (#487)", () => {
  it("needed plus extras minus stock, never below zero", () => {
    const lines = buildOrderLines(
      items,
      new Map([["item-knots", 5], ["item-camping", 2]]),
      new Map([["item-knots", 1], ["item-camping", 10]]),
      new Map([["item-knots", 2]]),
    );
    const byId = Object.fromEntries(lines.map((line) => [line.item.itemId, line]));
    // 5 needed + 2 extra - 1 in stock = 6 to order.
    expect(byId["item-knots"]).toMatchObject({ needed: 5, extra: 2, inStock: 1, toOrder: 6 });
    // 2 needed + 0 extra - 10 in stock would be negative: floored at 0.
    expect(byId["item-camping"]).toMatchObject({ needed: 2, extra: 0, inStock: 10, toOrder: 0 });
  });

  it("flags an item with no AdventSource catalog number, rather than dropping it", () => {
    const lines = buildOrderLines(items, new Map([["item-no-number", 3]]), new Map(), new Map());
    const line = lines.find((entry) => entry.item.itemId === "item-no-number")!;
    expect(line.missingCatalogNumber).toBe(true);
    expect(line.toOrder).toBe(3);
  });

  it("rejects a negative extra rather than letting it reduce the order", () => {
    const lines = buildOrderLines(items, new Map([["item-knots", 1]]), new Map(), new Map([["item-knots", -5]]));
    expect(lines.find((line) => line.item.itemId === "item-knots")).toMatchObject({ extra: 0, toOrder: 1 });
  });
});

describe("adventSourceOrderCsv (#487)", () => {
  it("has exactly two columns, catalog number and quantity, leading zeros kept", () => {
    const lines = buildOrderLines(items, new Map([["item-knots", 12], ["item-camping", 3]]), new Map(), new Map());
    const csv = adventSourceOrderCsv(lines);
    const rows = parseCsvMatrix(csv);
    expect(rows[0]).toEqual(["Catalog number", "Quantity"]);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.length === 2)).toBe(true);
    // Parsed back as text: leading zeros are still there, not read as a number.
    expect(rows.find((row) => row[1] === "12")?.[0]).toBe("002120");
    expect(rows.find((row) => row[1] === "3")?.[0]).toBe("000450");
  });

  it("never exports an item with no catalog number, or one with nothing to order", () => {
    const lines = buildOrderLines(items, new Map([["item-no-number", 4], ["item-camping", 0]]), new Map(), new Map());
    const rows = parseCsvMatrix(adventSourceOrderCsv(lines));
    expect(rows).toHaveLength(1);
  });
});

describe("readableOrderCsv (#487)", () => {
  it("names the item and flags a missing catalog number in plain text", () => {
    const lines = buildOrderLines(items, new Map([["item-no-number", 2]]), new Map(), new Map());
    const rows = parseCsvMatrix(readableOrderCsv(lines));
    expect(rows[1]).toEqual(["Wilderness Living", "No AdventSource number", "2", "2", "0", "0"]);
  });
});

describe("pickListCsv (#487)", () => {
  it("carries only names, the item, and where it stands", () => {
    const csv = pickListCsv([
      { lastName: "Sample", firstName: "Alex", itemName: "Knot Tying", status: "To order" },
      { lastName: "Demo", firstName: "Casey", itemName: "Camping Skills", status: "Ready to hand out (from stock)" },
    ]);
    const rows = parseCsvMatrix(csv);
    expect(rows[0]).toEqual(["Last name", "First name", "Item", "Status"]);
    expect(rows).toHaveLength(3);
    // Sorted by last name.
    expect(rows[1]).toEqual(["Demo", "Casey", "Camping Skills", "Ready to hand out (from stock)"]);
    expect(rows[2]).toEqual(["Sample", "Alex", "Knot Tying", "To order"]);
    // No column could ever carry a birth date, contact, guardian, or medical field.
    expect(rows[0]).toHaveLength(4);
    expect(csv).not.toMatch(/birth|phone|email|guardian|allerg|medical/i);
  });
});

describe("the stock model (#487)", () => {
  it("available stock is on hand less units received for someone and not yet handed out, never below zero", () => {
    expect(availableStock(5, 3)).toBe(2);
    expect(availableStock(3, 3)).toBe(0);
    // A hand-edited stock count lower than what's been received.
    expect(availableStock(1, 3)).toBe(0);
  });

  it("3 received-but-unawarded plus 2 new completions orders 2, not 0", () => {
    const [line] = buildOrderLines(
      [{ itemId: "item-knots", name: "Knot Tying", catalogNumber: "002120" }],
      new Map([["item-knots", 2]]),
      new Map([["item-knots", availableStock(3, 3)]]),
      new Map(),
    );
    expect(line).toMatchObject({ needed: 2, inStock: 0, toOrder: 2 });
  });

  it("stock covers the oldest needs first; the rest go on the order", () => {
    expect(splitNeedsByStock(["a", "b", "c", "d", "e"], 2)).toEqual({ fromStock: ["a", "b"], toOrder: ["c", "d", "e"] });
    expect(splitNeedsByStock(["a"], 4)).toEqual({ fromStock: ["a"], toOrder: [] });
    expect(splitNeedsByStock(["a", "b"], -1)).toEqual({ fromStock: [], toOrder: ["a", "b"] });
  });

  it("a full cycle leaves exactly the extras in stock: 5 needed, 2 in stock, 1 extra", () => {
    let onHand = 2;
    const [line] = buildOrderLines(
      [{ itemId: "item-knots", name: "Knot Tying", catalogNumber: "002120" }],
      new Map([["item-knots", 5]]),
      new Map([["item-knots", availableStock(onHand, 0)]]),
      new Map([["item-knots", 1]]),
    );
    expect(line.toOrder).toBe(4);
    const { fromStock, toOrder } = splitNeedsByStock([1, 2, 3, 4, 5], line.inStock);
    onHand -= fromStock.length; // handed out from stock
    onHand += line.toOrder; // received
    onHand -= toOrder.length; // awarded
    expect(onHand).toBe(1);
  });
});

describe("applyExtras (#487)", () => {
  it("applies the screen's typed extras exactly as the order does, ignoring junk", () => {
    const needed = new Map([["item-knots", 5], ["item-camping", 1]]);
    const base = buildOrderLines(items, needed, new Map([["item-knots", 2]]), new Map());
    const withExtras = applyExtras(base, { "item-knots": "3", "item-camping": "-4", "item-no-number": "abc" });
    const direct = buildOrderLines(items, needed, new Map([["item-knots", 2]]), new Map([["item-knots", 3]]));
    expect(withExtras).toEqual(direct);
    expect(withExtras.find((line) => line.item.itemId === "item-knots")).toMatchObject({ extra: 3, toOrder: 6 });
  });
});

