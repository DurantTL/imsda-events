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
import { clubSupplySectionLabels, resolveClubSupplySection } from "../modules/club-supplies/domain";
import { parseMasterAwardRulesFile } from "../modules/earned-awards/master-award-import";
import { parseCsvMatrix } from "../modules/imports/csv-parser";
import { toCsv } from "../modules/reporting/csv";

export const IMPORT_FILE_NAMES = {
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

export function buildMasterAwardRulesJson(sourceJson: string) {
  parseMasterAwardRulesFile(sourceJson); // fail here rather than ship a file the import refuses
  return `${JSON.stringify(JSON.parse(sourceJson), null, 2)}\n`;
}

export function buildImportFiles(root: string): Record<string, string> {
  const read = (file: string) => readFileSync(path.join(root, "docs/reference", file), "utf8");
  return {
    [IMPORT_FILE_NAMES.clubSupplies]: buildClubSupplyCatalogCsv(read("adventsource-club-catalog.csv")),
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
