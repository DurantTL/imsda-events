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
import { type HonorCategory, honorCategoryLabels, resolveHonorCategory } from "../modules/honors/domain";
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

const ADVANCED_TAIL = "-ADVANCED";

/**
 * Uppercase ASCII, each run of other characters as "-", trimmed, at most 40
 * characters. A long code is cut at the last "-" at or under the limit, so a
 * word is never cut in half (a single word longer than the limit is the one
 * exception), and a long "X - Advanced" name keeps its "-ADVANCED" ending so
 * it stays apart from the base honor.
 */
export function honorCodeFor(text: string) {
  const full = text
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (full.length <= HONOR_CODE_MAX_LENGTH) return full;
  const tail = full.endsWith(ADVANCED_TAIL) ? ADVANCED_TAIL : "";
  const body = full.slice(0, full.length - tail.length);
  const budget = HONOR_CODE_MAX_LENGTH - tail.length;
  let head = body;
  if (body.length > budget) {
    const cut = body.lastIndexOf("-", budget); // a "-" at index <= budget ends a whole word
    head = cut > 0 ? body.slice(0, cut) : body.slice(0, budget);
  }
  return `${head}${tail}`;
}

type HonorGroup = { category: HonorCategory; key: string; names: string[]; numbers: string[] };

/** The name a merged group goes by, whatever the row order: no "(GC)", else the shortest, then alphabetical. */
export function canonicalHonorName(names: readonly string[]) {
  const gc = (name: string) => /\(gc\)\s*$/i.test(name);
  return [...names].sort((a, b) => Number(gc(a)) - Number(gc(b)) || a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))[0];
}

/**
 * The honor catalog file: one honor per distinct section plus normalized name
 * of the honor sections (repeats merge, as the supply import does), in a
 * fixed order (category, then name), so the source's row order doesn't matter.
 *
 * The code is a system identifier derived from the name (`BASIC-RESCUE`).
 * `ledgerCsv` is the previously committed honors file: a honor already in it
 * keeps its code whatever else changes. Only a new honor whose code would
 * collide (with a ledger code or another new honor) gets its category added,
 * and a collision after that fails.
 */
export function buildHonorsCsv(sourceCsv: string, ledgerCsv?: string) {
  const [, ...rows] = parseCsvMatrix(sourceCsv);
  const groups = new Map<string, HonorGroup>();
  for (const [rawSection, item, catalogNumber] of rows) {
    const section = resolveClubSupplySection(rawSection);
    const category = section ? honorCategoryForSection(section) : null;
    if (!category) continue;
    const key = `${category}|${normalizeClubSupplyName(item)}`;
    const group = groups.get(key) ?? { category, key, names: [], numbers: [] };
    group.names.push(item.replace(/\s+/g, " ").trim());
    if (catalogNumber) group.numbers.push(catalogNumber);
    groups.set(key, group);
  }
  const categoryOrder = Object.keys(honorCategoryLabels);
  const honors = [...groups.values()]
    .map((group) => ({
      key: group.key,
      category: group.category,
      name: canonicalHonorName(group.names),
      // Repeats that disagree on a number: the lowest, not the first row's.
      catalogNumber: [...group.numbers].sort()[0] ?? "",
    }))
    .sort((a, b) => categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const ledger = new Map<string, string>();
  if (ledgerCsv) {
    for (const [code, name, , , , categoryText] of parseCsvMatrix(ledgerCsv).slice(1)) {
      const category = resolveHonorCategory(categoryText ?? "");
      if (code && name && category) ledger.set(`${category}|${normalizeClubSupplyName(name)}`, code);
    }
  }
  const keptCodes = new Set(honors.flatMap((honor) => (ledger.has(honor.key) ? [ledger.get(honor.key)!] : [])));
  const newBaseCount = new Map<string, number>();
  for (const honor of honors) {
    if (!ledger.has(honor.key)) newBaseCount.set(honorCodeFor(honor.name), (newBaseCount.get(honorCodeFor(honor.name)) ?? 0) + 1);
  }
  const coded = honors.map((honor) => {
    const kept = ledger.get(honor.key);
    if (kept) return { ...honor, code: kept };
    const base = honorCodeFor(honor.name);
    const collides = keptCodes.has(base) || newBaseCount.get(base)! > 1;
    return { ...honor, code: collides ? honorCodeFor(`${honorCategoryLabels[honor.category]} ${honor.name}`) : base };
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
  const ledgerFile = path.join(root, "docs/reference/imports", IMPORT_FILE_NAMES.honors);
  return {
    [IMPORT_FILE_NAMES.honors]: buildHonorsCsv(catalog, existsSync(ledgerFile) ? readFileSync(ledgerFile, "utf8") : undefined),
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
