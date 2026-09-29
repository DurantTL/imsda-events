import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildImportFiles, IMPORT_FILE_NAMES } from "@/scripts/build-import-files";
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
