import { describe, expect, it } from "vitest";
import {
  activeHelperLines,
  buildHelperLines,
  orderListCsv,
  orderListSectionFor,
  type HelperCatalogItem,
  type OrderExportHeader,
} from "@/modules/club-orders/domain";
import { clubOrderListQuantitySchema } from "@/modules/club-orders/schemas";
import { parseCsvMatrix } from "@/modules/imports/csv-parser";

/**
 * The order helper list (#654): sections, sized lines with their own item
 * numbers, director edits, on hand versus to order, and the export. Synthetic
 * data only.
 */

const items: HelperCatalogItem[] = [
  { itemId: "shirt-m", section: "CLASS_A_DRESS_APPAREL", name: "Boys' Short Sleeve Shirt (M)", catalogNumber: "011112", sizeLabel: "M" },
  { itemId: "shirt-s", section: "CLASS_A_DRESS_APPAREL", name: "Boys' Short Sleeve Shirt (S)", catalogNumber: "011111", sizeLabel: "S" },
  { itemId: "knots", section: "OUTDOOR_INDUSTRIES", name: "Knot Tying", catalogNumber: "002120", sizeLabel: null },
  { itemId: "camping", section: "RECREATION", name: "Camping Skills I", catalogNumber: "000450", sizeLabel: null },
  { itemId: "star", section: "MISCELLANEOUS", name: "Good Conduct Star", catalogNumber: null, sizeLabel: null },
];

const header: OrderExportHeader = {
  clubName: "Test Pathfinders",
  church: "Sample Church",
  directorName: "Test Director",
  directorEmail: "director@example.test",
  directorPhone: "555-0100",
  date: "2026-09-30",
};

describe("orderListSectionFor (#654)", () => {
  it("puts apparel in Uniforms, honor categories in Honors, everything else in Other", () => {
    expect(orderListSectionFor("CLASS_A_DRESS_APPAREL")).toBe("UNIFORMS");
    expect(orderListSectionFor("OTHER_APPAREL")).toBe("UNIFORMS");
    expect(orderListSectionFor("NATURE")).toBe("HONORS");
    expect(orderListSectionFor("MASTER_AWARDS")).toBe("HONORS");
    expect(orderListSectionFor("INVESTITURE")).toBe("OTHER");
    expect(orderListSectionFor("MISCELLANEOUS")).toBe("OTHER");
    expect(orderListSectionFor("TEEN_LEADERSHIP_TRAINING")).toBe("OTHER");
  });
});

describe("buildHelperLines (#654)", () => {
  const build = (computed: Array<[string, number]>, overrides: Array<[string, number]> = [], onHand: Array<[string, number]> = []) =>
    buildHelperLines(items, new Map(computed), new Map(overrides), new Map(onHand));

  it("orders Uniforms, then Honors, then other supplies; a sized item is one line per size with its own number", () => {
    const lines = build([["shirt-m", 2], ["shirt-s", 1], ["knots", 3], ["camping", 1], ["star", 4]]);
    expect(lines.map((line) => line.section)).toEqual(["UNIFORMS", "UNIFORMS", "HONORS", "HONORS", "OTHER"]);
    expect(lines.slice(0, 2).map((line) => [line.name, line.size, line.catalogNumber])).toEqual([
      ["Boys' Short Sleeve Shirt", "M", "011112"],
      ["Boys' Short Sleeve Shirt", "S", "011111"],
    ]);
    expect(lines.filter((line) => line.section === "HONORS").map((line) => line.name)).toEqual(["Camping Skills I", "Knot Tying"]);
  });

  it("needed minus on hand is to order, never below zero", () => {
    const [line] = build([["knots", 5]], [], [["knots", 2]]).filter((entry) => entry.itemId === "knots");
    expect(line).toMatchObject({ needed: 5, onHand: 2, toOrder: 3 });
    const covered = build([["knots", 2]], [], [["knots", 6]]).find((entry) => entry.itemId === "knots");
    expect(covered).toMatchObject({ needed: 2, onHand: 6, toOrder: 0 });
  });

  it("a director's quantity replaces the computed count, 0 takes the line off, and an item nothing calls for can be added", () => {
    const lines = build([["knots", 3], ["camping", 1]], [["knots", 7], ["camping", 0], ["star", 2]]);
    const byId = Object.fromEntries(lines.map((line) => [line.itemId, line]));
    expect(byId.knots).toMatchObject({ computedNeeded: 3, needed: 7, edited: true, toOrder: 7 });
    expect(byId.camping).toMatchObject({ computedNeeded: 1, needed: 0, edited: true });
    expect(byId.star).toMatchObject({ computedNeeded: 0, needed: 2, edited: true });
    expect(activeHelperLines(lines).map((line) => line.itemId).sort()).toEqual(["knots", "star"]);
  });

  it("raising the on-hand count lowers to order", () => {
    const before = build([["knots", 4]], [], [["knots", 0]]).find((line) => line.itemId === "knots");
    const after = build([["knots", 4]], [], [["knots", 3]]).find((line) => line.itemId === "knots");
    expect(before?.toOrder).toBe(4);
    expect(after?.toOrder).toBe(1);
  });
});

describe("orderListCsv (#654)", () => {
  const lines = buildHelperLines(
    items,
    new Map([["shirt-m", 2], ["knots", 3], ["camping", 1], ["star", 4]]),
    new Map([["camping", 0]]),
    new Map([["knots", 1]]),
  );

  it("starts with the club, church, director contact and date", () => {
    const rows = parseCsvMatrix(orderListCsv(header, lines));
    expect(rows.slice(0, 6)).toEqual([
      ["Club", "Test Pathfinders"],
      ["Church", "Sample Church"],
      ["Director", "Test Director"],
      ["Director email", "director@example.test"],
      ["Director phone", "555-0100"],
      ["Date", "2026-09-30"],
    ]);
  });

  it("lists every line grouped by section with name, size, item number and quantity; removed lines stay out", () => {
    const rows = parseCsvMatrix(orderListCsv(header, lines)).filter((row) => row.length > 2);
    expect(rows[0]).toEqual(["Section", "Item name", "Size", "Item number", "Quantity needed", "Calculated", "Available", "To order"]);
    expect(rows.slice(1)).toEqual([
      ["Uniforms", "Boys' Short Sleeve Shirt", "M", "011112", "2", "2", "0", "2"],
      ["Honors", "Knot Tying", "", "002120", "3", "3", "1", "2"],
      ["Other supplies and insignia", "Good Conduct Star", "", "", "4", "4", "0", "4"],
    ]);
  });

  it("adds a Calculated column showing the computed count beside a changed quantity", () => {
    const edited = buildHelperLines(items, new Map([["knots", 3]]), new Map([["knots", 7]]), new Map());
    const rows = parseCsvMatrix(orderListCsv(header, edited)).filter((row) => row.length > 2);
    expect(rows[1]).toEqual(["Honors", "Knot Tying", "", "002120", "7", "3", "0", "7"]);
  });

  it("neutralises a header value that starts with a formula character", () => {
    const formula = ["=", "HYPERLINK(1)"].join("");
    const csv = orderListCsv({ ...header, clubName: formula, directorName: "+cmd", directorEmail: "@x", directorPhone: "-1" }, lines);
    expect(csv).toContain(`"Club","'${formula}"`);
    expect(csv).toContain(`"Director","'+cmd"`);
    expect(csv).toContain(`"Director email","'@x"`);
    expect(csv).toContain(`"Director phone","'-1"`);
  });

  it("keeps leading zeros in item numbers as text", () => {
    expect(orderListCsv(header, lines)).toContain('"011112"');
  });
});

describe("clubOrderListQuantitySchema (#654)", () => {
  it("accepts a whole quantity from 0 up, or null to reset", () => {
    expect(clubOrderListQuantitySchema.parse({ quantity: 0 })).toEqual({ quantity: 0 });
    expect(clubOrderListQuantitySchema.parse({ quantity: 10_000 })).toEqual({ quantity: 10_000 });
    expect(clubOrderListQuantitySchema.parse({ quantity: null })).toEqual({ quantity: null });
  });

  it.each([{ quantity: -1 }, { quantity: 2.5 }, { quantity: 10_001 }, { quantity: "2" }, {}])("refuses %j", (body) => {
    expect(clubOrderListQuantitySchema.safeParse(body).success).toBe(false);
  });
});
