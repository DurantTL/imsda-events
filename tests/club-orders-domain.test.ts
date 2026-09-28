import { describe, expect, it } from "vitest";
import {
  adventSourceOrderCsv,
  buildOrderLines,
  pickListCsv,
  readableOrderCsv,
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
  it("carries only names and the item, nothing else", () => {
    const csv = pickListCsv([
      { lastName: "Sample", firstName: "Alex", itemName: "Knot Tying" },
      { lastName: "Demo", firstName: "Casey", itemName: "Camping Skills" },
    ]);
    const rows = parseCsvMatrix(csv);
    expect(rows[0]).toEqual(["Last name", "First name", "Item"]);
    expect(rows).toHaveLength(3);
    // Sorted by last name.
    expect(rows[1]).toEqual(["Demo", "Casey", "Camping Skills"]);
    expect(rows[2]).toEqual(["Sample", "Alex", "Knot Tying"]);
    // No column could ever carry a birth date, contact, guardian, or medical field.
    expect(rows[0]).toHaveLength(3);
    expect(csv).not.toMatch(/birth|phone|email|guardian|allerg|medical/i);
  });
});
