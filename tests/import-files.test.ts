import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildHonorsCsv, buildImportFiles, canonicalHonorName, honorCodeFor, IMPORT_FILE_NAMES } from "@/scripts/build-import-files";
import { honorCsvTemplate, parseHonorCsv, planHonorImport } from "@/modules/honors/catalog-csv";
import { clubSupplyCsvTemplate, parseClubSupplyCsv, planClubSupplyImport } from "@/modules/club-supplies/catalog-csv";
import { honorCategoryForSection, normalizeClubSupplyName } from "@/modules/club-supplies/domain";
import { parseMasterAwardRulesFile, planMasterAwardImport } from "@/modules/earned-awards/master-award-import";
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

    it("matches every honor name against honors.csv plus the supply items, with 0 unmatched", () => {
      const honors = parseHonorCsv(committed(IMPORT_FILE_NAMES.honors)).map((row, index) => ({ id: `h-${index}`, name: row.name, isActive: true }));
      const items = parseClubSupplyCsv(committed(IMPORT_FILE_NAMES.clubSupplies))
        .filter((row) => row.section === "MASTER_AWARDS")
        .map((row, index) => ({ id: `i-${index}`, name: row.name }));
      expect(items).toHaveLength(15);
      const plan = planMasterAwardImport(parseMasterAwardRulesFile(text), new Set(), honors, items);
      expect(plan.summary.honorsUnmatched).toBe(0);
      expect(plan.unmatched).toEqual([]);
      expect(plan.summary.honorsMatched).toBeGreaterThan(0);
    });
  });
});

describe("honor codes (#622)", () => {
  const source = (rows: string[]) => ["section,item,adventsource_catalog_number", ...rows].join("\n");
  const codes = (csv: string) => new Map(parseHonorCsv(csv).map((row) => [row.name, row.code]));
  const shuffled = <T,>(list: T[], seed: number) => {
    const copy = [...list];
    let state = seed;
    for (let i = copy.length - 1; i > 0; i -= 1) {
      state = (state * 1103515245 + 12345) % 2147483648;
      const j = state % (i + 1);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };

  it("gives the same file whatever the order of the source rows", () => {
    const real = readFileSync(path.join(process.cwd(), "docs/reference/adventsource-club-catalog.csv"), "utf8").trimEnd().split(/\r?\n/);
    const [header, ...rows] = real;
    const expected = buildHonorsCsv(real.join("\n"));
    for (const seed of [1, 2, 3]) expect(buildHonorsCsv([header, ...shuffled(rows, seed)].join("\n"))).toBe(expected);
    expect(buildHonorsCsv([header, ...[...rows].reverse()].join("\n"))).toBe(expected);
    // A merged "(GC)" group: the name (so the code) doesn't depend on which row came first.
    const group = ["Vocational,Welding (GC),", "Vocational,Welding,001234", "Vocational,welding,"];
    const a = buildHonorsCsv(source(group));
    for (const seed of [1, 2, 3, 4]) expect(buildHonorsCsv(source(shuffled(group, seed)))).toBe(a);
    expect([...codes(a).entries()]).toEqual([["Welding", "WELDING"]]);
    expect(parseHonorCsv(a)[0].catalogNumber).toBe("001234");
  });

  it("picks the name without (GC), else the shortest, then alphabetical", () => {
    expect(canonicalHonorName(["Video (GC)", "Video"])).toBe("Video");
    expect(canonicalHonorName(["Zoo Keeping", "Zoo keeping"])).toBe("Zoo Keeping");
    expect(canonicalHonorName(["Bb (GC)", "Aaa (GC)"])).toBe("Bb (GC)");
  });

  it("keeps an existing honor's code, and only a new colliding honor gets the category", () => {
    const ledger = toCsvForTest([["OLD-CODE", "Rescue", "", "", "", "Nature"]]);
    const rows = ["Nature,Rescue,", "Vocational,Rescue,", "Recreation,Kayaking,"];
    const built = codes(buildHonorsCsv(source(rows), ledger));
    expect(built.get("Rescue")).toBeDefined();
    const byCategory = parseHonorCsv(buildHonorsCsv(source(rows), ledger));
    const nature = byCategory.find((row) => row.category === "NATURE")!;
    const vocational = byCategory.find((row) => row.category === "VOCATIONAL")!;
    expect(nature.code).toBe("OLD-CODE");
    expect(vocational.code).toBe("RESCUE");
    // A new honor whose plain code is already a ledger code takes the category prefix; the ledger one is untouched.
    const clash = parseHonorCsv(buildHonorsCsv(source(["Nature,Old Code,", "Nature,Rescue,"]), ledger));
    expect(clash.find((row) => row.name === "Rescue")!.code).toBe("OLD-CODE");
    expect(clash.find((row) => row.name === "Old Code")!.code).toBe("NATURE-OLD-CODE");
    // Without a ledger the two same-name honors both get the category.
    const fresh = parseHonorCsv(buildHonorsCsv(source(rows)));
    expect(fresh.filter((row) => row.name === "Rescue").map((row) => row.code).sort()).toEqual(["NATURE-RESCUE", "VOCATIONAL-RESCUE"]);
    // Adding a colliding honor later never recodes the first one.
    const later = parseHonorCsv(buildHonorsCsv(source(["Nature,Rescue,", "Vocational,Rescue,"]), toCsvForTest([["RESCUE", "Rescue", "", "", "", "Nature"]])));
    expect(later.find((row) => row.category === "NATURE")!.code).toBe("RESCUE");
    expect(later.find((row) => row.category === "VOCATIONAL")!.code).toBe("VOCATIONAL-RESCUE");
  });

  it("fails loudly when a collision survives the category prefix", () => {
    expect(() => buildHonorsCsv(source(["Nature,Rescue!,", "Nature,Rescue?,"]))).toThrow(/used by both/);
  });

  it("cuts a long code at a whole word, keeps -ADVANCED, and stays unique and under 40", () => {
    expect(honorCodeFor("African American Adventist Heritage in the NAD")).toBe("AFRICAN-AMERICAN-ADVENTIST-HERITAGE-IN");
    expect(honorCodeFor("African American Adventist Heritage in the NAD - Advanced")).toBe("AFRICAN-AMERICAN-ADVENTIST-ADVANCED");
    expect(honorCodeFor("Supercalifragilisticexpialidocious Honor Names Are Long")).toBe("SUPERCALIFRAGILISTICEXPIALIDOCIOUS-HONOR");
    expect(honorCodeFor("A".repeat(50))).toBe("A".repeat(40));
    const rows = parseHonorCsv(committed(IMPORT_FILE_NAMES.honors));
    expect(new Set(rows.map((row) => row.code)).size).toBe(rows.length);
    for (const row of rows) {
      expect(row.code.length).toBeLessThanOrEqual(40);
      // Every code is whole words of the name (never a word cut in half), unless the name has a word over 40 characters.
      const nameWords = honorCodeFor(row.name.length > 0 ? row.name.replace(/\s+/g, " ") : "").split("-");
      const codeWords = row.code.split("-");
      const dropAdvanced = codeWords[codeWords.length - 1] === "ADVANCED" ? codeWords.length - 1 : codeWords.length;
      for (let i = 0; i < dropAdvanced; i += 1) expect(nameWords[i], row.name).toBe(codeWords[i]);
    }
  });
});

function toCsvForTest(rows: string[][]) {
  return [["Code", "Name", "Description", "Active", "Catalog Number", "Category"], ...rows].map((row) => row.map((cell) => `"${cell}"`).join(",")).join("\r\n");
}
