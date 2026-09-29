import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildImportFiles, honorCodeFor, IMPORT_FILE_NAMES } from "@/scripts/build-import-files";
import { honorCsvTemplate, parseHonorCsv, planHonorImport } from "@/modules/honors/catalog-csv";
import { clubSupplyCsvTemplate, parseClubSupplyCsv, planClubSupplyImport } from "@/modules/club-supplies/catalog-csv";
import { honorCategoryForSection, normalizeClubSupplyName } from "@/modules/club-supplies/domain";
import { parseMasterAwardRulesFile } from "@/modules/earned-awards/master-award-import";
import { parseCsvMatrix } from "@/modules/imports/csv-parser";

/**
 * The committed import files (#622): each parses with the real import parser
 * with no errors, and each is exactly what `scripts/build-import-files.ts`
 * produces from the reference data.
 */
const root = process.cwd();
const committed = (name: string) => readFileSync(path.join(root, "docs/reference/imports", name), "utf8");

describe("committed import files (#622)", () => {
  it("match what the generator produces", () => {
    const built = buildImportFiles(root);
    expect(Object.keys(built).sort()).toEqual(Object.values(IMPORT_FILE_NAMES).sort());
    for (const [name, content] of Object.entries(built)) expect(committed(name), name).toBe(content);
  });

  describe("club supply catalog CSV", () => {
    const text = committed(IMPORT_FILE_NAMES.clubSupplies);

    it("starts with exactly the template's header row", () => {
      expect(`${text.split("\r\n")[0]}\r\n`).toBe(clubSupplyCsvTemplate());
    });

    it("parses with zero errors and keeps every source row", () => {
      const rows = parseClubSupplyCsv(text);
      expect(rows).toHaveLength(850);
      expect(rows.filter((row) => row.problems.length > 0 || !row.section)).toEqual([]);
      const plan = planClubSupplyImport(rows, [], []);
      expect(plan.summary.problems).toBe(0);
      expect(plan.summary.added + plan.summary.duplicates).toBe(850);
    });

    it("carries the source's items, numbers and quirks unchanged", () => {
      const source = parseCsvMatrix(readFileSync(path.join(root, "docs/reference/adventsource-club-catalog.csv"), "utf8")).slice(1);
      const rows = parseClubSupplyCsv(text);
      expect(rows.map((row) => row.name)).toEqual(source.map(([, item]) => item.replace(/\s+/g, " ").trim()));
      expect(rows.map((row) => row.catalogNumber)).toEqual(source.map(([, , number]) => number || null));
      // Section labels map to the import's own sections; "Reacreation" reads as Recreation.
      expect(rows.filter((row) => row.section === "RECREATION")).toHaveLength(111);
      expect(parseCsvMatrix(text).some(([section]) => section === "Reacreation")).toBe(false);
      // Active is blank: items take the import's default.
      expect(rows.filter((row) => row.isActive !== undefined)).toEqual([]);
    });

    it("has no personal data: only catalog names, and no notes", () => {
      const cells = parseCsvMatrix(text).slice(1);
      expect(cells.filter(([, item]) => item.includes("?") || item.length > 70)).toEqual([]);
      expect(text).not.toMatch(/@/);
    });
  });

  describe("honor catalog CSV", () => {
    const text = committed(IMPORT_FILE_NAMES.honors);

    it("starts with exactly the template's header row", () => {
      expect(`${text.split("\r\n")[0]}\r\n`).toBe(honorCsvTemplate());
    });

    it("parses with zero errors, with a unique code of at most 40 uppercase characters each", () => {
      const rows = parseHonorCsv(text);
      expect(rows).toHaveLength(546);
      expect(rows.filter((row) => row.problems.length > 0)).toEqual([]);
      expect(new Set(rows.map((row) => row.code)).size).toBe(rows.length);
      expect(rows.filter((row) => !/^[A-Z0-9]+(-[A-Z0-9]+)*$/.test(row.code) || row.code.length > 40)).toEqual([]);
      expect(planHonorImport(rows, []).filter((step) => step.action !== "ADD")).toEqual([]);
      // Description and Active stay blank.
      expect(rows.filter((row) => row.description !== undefined || row.isActive !== undefined)).toEqual([]);
    });

    it("derives codes from names, deterministically", () => {
      expect(honorCodeFor("Basic Rescue")).toBe("BASIC-RESCUE");
      expect(honorCodeFor("  Bogs & Fens - Advanced ")).toBe("BOGS-FENS-ADVANCED");
      expect(honorCodeFor("A".repeat(30) + " Very Long Honor Name - Advanced")).toMatch(/-ADVANCED$/);
      expect(honorCodeFor("A".repeat(30) + " Very Long Honor Name - Advanced").length).toBeLessThanOrEqual(40);
    });

    it("has one honor per honor-section item, with the source's number and category", () => {
      const honors = parseHonorCsv(text);
      const items = parseClubSupplyCsv(committed(IMPORT_FILE_NAMES.clubSupplies)).filter((row) => row.section && honorCategoryForSection(row.section));
      const distinct = new Set(items.map((row) => `${row.section}|${row.normalizedName}`));
      expect(honors).toHaveLength(distinct.size);
      const byName = new Map(honors.map((honor) => [`${honor.category}|${normalizeClubSupplyName(honor.name)}`, honor]));
      for (const item of items) {
        const honor = byName.get(`${item.section}|${item.normalizedName}`);
        expect(honor, item.name).toBeDefined();
        if (item.catalogNumber) expect(honor!.catalogNumber, item.name).toBe(item.catalogNumber);
      }
    });

    it("links every honor row of the supply file once honors are imported", () => {
      const existing = parseHonorCsv(text).map((row, index) => ({
        id: `h-${index}`,
        code: row.code,
        name: row.name,
        catalogNumber: row.catalogNumber ?? null,
        category: row.category ?? null,
        updatedAt: new Date(0),
      }));
      const plan = planClubSupplyImport(parseClubSupplyCsv(committed(IMPORT_FILE_NAMES.clubSupplies)), [], existing);
      expect(plan.summary.honorsUnmatched).toBe(0);
      expect(plan.summary.honorsMatched).toBe(546);
      expect(plan.summary.honorsUpdated).toBe(0);
    });
  });

  describe("master award rules JSON", () => {
    const text = committed(IMPORT_FILE_NAMES.masterAwards);

    it("parses with the real rules parser and holds the 15 rules", () => {
      expect(parseMasterAwardRulesFile(text)).toHaveLength(15);
    });

    it("names only honors that are rows in the club supply catalog", () => {
      const catalog = new Set(
        parseClubSupplyCsv(committed(IMPORT_FILE_NAMES.clubSupplies))
          .filter((row) => row.section && honorCategoryForSection(row.section))
          .map((row) => normalizeClubSupplyName(row.name)),
      );
      const missing = parseMasterAwardRulesFile(text)
        .flatMap((rule) => rule.groups.flatMap((group) => group.honors))
        .filter((name) => !catalog.has(normalizeClubSupplyName(name)));
      expect(missing).toEqual([]);
    });
  });
});
