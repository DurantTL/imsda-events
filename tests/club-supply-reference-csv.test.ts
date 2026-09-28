import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseClubSupplyCsv, planClubSupplyImport } from "@/modules/club-supplies/catalog-csv";
import { normalizeClubSupplyName, resolveClubSupplySection } from "@/modules/club-supplies/domain";
import { parseCsvMatrix } from "@/modules/imports/csv-parser";

/**
 * The committed reference file (#531), checked row by row. It holds only the
 * sheet's header rows: no total or label rows, no free-text notes, nothing a
 * member wrote. And the whole file imports with no row dropped.
 */
const file = readFileSync(path.join(process.cwd(), "docs/reference/adventsource-club-catalog.csv"), "utf8");
const [header, ...rows] = parseCsvMatrix(file);

const LABEL_ROW = /^\s*(grand\s+)?totals?\b|\btotals?\s*:?\s*$|#\s*(needed|in\s*stock|to\s*order|extras?)|\bneeded\b|last\s+updated|^\s*(extras?|subtotal|order\s+list|in\s+stock)\b/i;

describe("AdventSource reference CSV (#531)", () => {
  it("has exactly the three header-row columns and 850 rows", () => {
    expect(header).toEqual(["section", "item", "adventsource_catalog_number"]);
    expect(rows).toHaveLength(850);
    for (const row of rows) expect(row).toHaveLength(3);
  });

  it("has no total or label rows", () => {
    const labels = rows.filter(([section, item]) => LABEL_ROW.test(item) || LABEL_ROW.test(section));
    expect(labels).toEqual([]);
    // The pattern itself catches the sheet's label rows.
    for (const label of ["Total", "Grand Total", "# Needed", "# in stock", "Last Updated 9/1", "Extras", "Items total:"]) {
      expect(LABEL_ROW.test(label), label).toBe(true);
    }
    // ...and doesn't trip on a real item that merely contains a word from one.
    expect(LABEL_ROW.test("Livestock")).toBe(false);
  });

  it("has no free-text notes: no question marks and no name over 70 characters", () => {
    expect(rows.filter(([, item]) => item.includes("?") || item.length > 70)).toEqual([]);
    expect(rows.filter(([section]) => section.includes("?"))).toEqual([]);
  });

  it("uses only known sections, and six-digit catalog numbers or none", () => {
    expect(rows.filter(([section]) => !resolveClubSupplySection(section))).toEqual([]);
    expect(rows.filter(([, , number]) => number !== "" && !/^\d{6}$/.test(number))).toEqual([]);
    expect(rows.filter(([, item]) => item.trim() === "")).toEqual([]);
  });

  it("imports in full with no row dropped: every row is an item or merged into an identical earlier one", () => {
    const parsed = parseClubSupplyCsv(file);
    expect(parsed).toHaveLength(850);
    expect(parsed.filter((row) => row.problems.length > 0)).toEqual([]);

    const plan = planClubSupplyImport(parsed, [], []);
    const distinct = new Set(parsed.map((row) => `${row.section}|${normalizeClubSupplyName(row.name)}`));
    expect(plan.summary.problems).toBe(0);
    expect(plan.summary.added).toBe(distinct.size);
    expect(plan.summary.added + plan.summary.duplicates).toBe(850);
    const added = new Set(plan.steps.filter((step) => step.action === "ADD").map((step) => step.line));
    for (const step of plan.steps.filter((candidate) => candidate.action !== "ADD")) {
      expect(step.duplicateOfLine, `line ${step.line}`).not.toBeNull();
      expect(added.has(step.duplicateOfLine!)).toBe(true);
    }
    // The only merges: the source's repeated PBE pins, and two unnumbered
    // "(GC)" rows that name the same honor as the numbered row above them.
    expect(plan.steps.filter((step) => step.duplicateOfLine !== null).map((step) => step.name).sort()).toEqual([
      "PBE Pin 2016", "PBE Pin 2017", "PBE Pin 2018", "PBE Pin 2023", "PBE Pin 2025", "Video (GC)", "Welding (GC)",
    ]);
  });

  it("keeps repeated catalog numbers, only warning about them", () => {
    const plan = planClubSupplyImport(parseClubSupplyCsv(file), [], []);
    const repeated = new Map(plan.repeatedNumbers.map((entry) => [entry.catalogNumber, entry.count]));
    expect(repeated.get("002305")).toBe(6);
    expect(repeated.get("008585")).toBe(2);
    expect(repeated.get("007400")).toBe(121);
    // Every "X - Advanced" honor is the Advanced Honor Star, except First Aid,
    // which AdventSource sells as its own patch.
    const advanced = plan.steps.filter((step) => /- Advanced$/.test(step.name));
    expect(advanced).toHaveLength(121);
    expect(advanced.filter((step) => step.write?.catalogNumber !== "007400").map((step) => [step.name, step.write?.catalogNumber]))
      .toEqual([["First Aid - Advanced", "005565"]]);
  });

  it("counts honor rows matched and unmatched against the honor catalog", () => {
    const honors = [
      { id: "h-1", code: "SYN-001", name: "Bogs and Fens", catalogNumber: null, category: null, updatedAt: new Date(0) },
      { id: "h-2", code: "SYN-002", name: "Bogs & Fens, Advanced", catalogNumber: null, category: null, updatedAt: new Date(0) },
    ];
    const plan = planClubSupplyImport(parseClubSupplyCsv(file), [], honors);
    const honorRows = plan.steps.filter((step) => step.honorMatch !== null);
    expect(plan.summary.honorsMatched).toBe(2);
    expect(plan.summary.honorsUnmatched).toBe(honorRows.length - 2);
    expect(plan.steps.find((step) => step.name === "Bogs & Fens")?.honorUpdate).toEqual({ honorId: "h-1", catalogNumber: "005157", category: "NATURE" });
    expect(plan.steps.find((step) => step.name === "Bogs & Fens - Advanced")?.honorUpdate).toEqual({ honorId: "h-2", catalogNumber: "007400", category: "NATURE" });
  });
});
