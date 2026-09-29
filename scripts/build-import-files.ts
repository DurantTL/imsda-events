/**
 * Builds the ready-to-upload staff import files under `docs/reference/imports/`
 * (#622) from the reference data already committed in `docs/reference/`. The
 * files are rebuilt, never hand-edited:
 *
 *   npm run imports:build              writes the files
 *   npm run imports:build -- --check   exits 1 when a committed file is stale
 *
 * Nothing is invented: every value comes from a source file, and a field the
 * source doesn't have stays blank where the import allows it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CLUB_SUPPLY_CSV_HEADERS } from "../modules/club-supplies/catalog-csv";
import { clubSupplySectionLabels, honorCategoryForSection, normalizeClubSupplyName, resolveClubSupplySection } from "../modules/club-supplies/domain";
import { HONOR_CSV_HEADERS } from "../modules/honors/catalog-csv";
import { honorCategoryLabels } from "../modules/honors/domain";
import { parseMasterAwardRulesFile } from "../modules/earned-awards/master-award-import";
import { parseCsvMatrix } from "../modules/imports/csv-parser";
import { toCsv } from "../modules/reporting/csv";

export const IMPORT_FILE_NAMES = {
  honors: "honors.csv",
  clubSupplies: "club-supply-catalog.csv",
  masterAwards: "master-award-rules.json",
} as const;

export function buildClubSupplyCatalogCsv(sourceCsv: string) {
  const [header, ...rows] = parseCsvMatrix(sourceCsv);
  if (header.join(",") !== "section,item,adventsource_catalog_number") {
    throw new Error("adventsource-club-catalog.csv doesn't have the expected columns.");
  }
  const out: string[][] = [[...CLUB_SUPPLY_CSV_HEADERS]];
  for (const [rawSection, item, catalogNumber] of rows) {
    const section = resolveClubSupplySection(rawSection);
    if (!section) throw new Error(`"${rawSection}" isn't a club supply section.`);
    // Section is the import's own label; a blank Catalog Number stays blank; Active is left
    // blank so each item takes the import's default (active).
    out.push([clubSupplySectionLabels[section], item, catalogNumber ?? "", ""]);
  }
  return toCsv(out);
}

/** The honor import's code limit (`parseHonorCsv` slices codes to 40). */
export const HONOR_CODE_MAX_LENGTH = 40;

/** Uppercase ASCII, each run of other characters as "-", trimmed, at most 40 characters. */
export function honorCodeFor(text: string) {
  const full = text
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (full.length <= HONOR_CODE_MAX_LENGTH) return full;
  // A long "X - Advanced" name keeps its "-ADVANCED" ending, so it stays apart from the base honor.
  const tail = full.endsWith("-ADVANCED") ? "-ADVANCED" : "";
  const head = full.slice(0, full.length - tail.length).slice(0, HONOR_CODE_MAX_LENGTH - tail.length).replace(/-+$/g, "");
  return `${head}${tail}`;
}

/**
 * The honor catalog file: one honor per distinct section plus normalized name
 * of the honor sections (repeats merge, as the supply import does). The code
 * is a system identifier derived from the name (`BASIC-RESCUE`); two honors
 * that collide get their category added, and a collision after that fails.
 */
export function buildHonorsCsv(sourceCsv: string) {
  const [, ...rows] = parseCsvMatrix(sourceCsv);
  const honors = new Map<string, { name: string; category: keyof typeof honorCategoryLabels; catalogNumber: string }>();
  for (const [rawSection, item, catalogNumber] of rows) {
    const section = resolveClubSupplySection(rawSection);
    const category = section ? honorCategoryForSection(section) : null;
    if (!category) continue;
    const key = `${category}|${normalizeClubSupplyName(item)}`;
    const existing = honors.get(key);
    if (!existing) honors.set(key, { name: item.replace(/\s+/g, " ").trim(), category, catalogNumber: catalogNumber ?? "" });
    else if (!existing.catalogNumber && catalogNumber) existing.catalogNumber = catalogNumber;
  }
  const list = [...honors.values()];
  const nameCount = new Map<string, number>();
  for (const honor of list) nameCount.set(honorCodeFor(honor.name), (nameCount.get(honorCodeFor(honor.name)) ?? 0) + 1);
  const coded = list.map((honor) => {
    const base = honorCodeFor(honor.name);
    return { ...honor, code: nameCount.get(base)! > 1 ? honorCodeFor(`${honorCategoryLabels[honor.category]} ${honor.name}`) : base };
  });
  const seen = new Map<string, string>();
  for (const honor of coded) {
    if (!honor.code) throw new Error(`Honor "${honor.name}" has no usable code.`);
    const other = seen.get(honor.code);
    if (other) throw new Error(`Honor code ${honor.code} is used by both "${other}" and "${honor.name}".`);
    seen.set(honor.code, honor.name);
  }
  return toCsv([
    [...HONOR_CSV_HEADERS],
    ...coded.map((honor) => [honor.code, honor.name, "", "", honor.catalogNumber, honorCategoryLabels[honor.category]]),
  ]);
}

export function buildMasterAwardRulesJson(sourceJson: string) {
  parseMasterAwardRulesFile(sourceJson); // fail here rather than ship a file the import refuses
  return `${JSON.stringify(JSON.parse(sourceJson), null, 2)}\n`;
}

export function buildImportFiles(root: string): Record<string, string> {
  const read = (file: string) => readFileSync(path.join(root, "docs/reference", file), "utf8");
  const catalog = read("adventsource-club-catalog.csv");
  return {
    [IMPORT_FILE_NAMES.honors]: buildHonorsCsv(catalog),
    [IMPORT_FILE_NAMES.clubSupplies]: buildClubSupplyCatalogCsv(catalog),
    [IMPORT_FILE_NAMES.masterAwards]: buildMasterAwardRulesJson(read("master-award-rules.json")),
  };
}

function main() {
  const root = process.cwd();
  const dir = path.join(root, "docs/reference/imports");
  const files = buildImportFiles(root);
  if (process.argv.includes("--check")) {
    const stale = Object.entries(files).filter(([name, content]) => {
      const file = path.join(dir, name);
      return !existsSync(file) || readFileSync(file, "utf8") !== content;
    });
    if (stale.length > 0) {
      console.error(`Stale import files: ${stale.map(([name]) => name).join(", ")}. Run npm run imports:build.`);
      process.exit(1);
    }
    console.log("Import files are up to date.");
    return;
  }
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content);
    console.log(`Wrote docs/reference/imports/${name}`);
  }
}

if (process.argv[1]?.endsWith("build-import-files.ts")) main();
