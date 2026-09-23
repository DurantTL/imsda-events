import { normalizeHonorCode } from "@/modules/honors/domain";
import { parseCsvMatrix } from "@/modules/imports/csv-parser";
import { toCsv } from "@/modules/reporting/csv";

/**
 * Honor catalog CSV (#385). Honors are matched by code: a new code is added,
 * a known code is updated with what the file fills in. An honor that isn't in
 * the file is left alone; imports never delete or deactivate by omission.
 */

export const HONOR_CSV_HEADERS = ["Code", "Name", "Description", "Active"] as const;
export const MAX_HONOR_CSV_ROWS = 2000;
export const MAX_HONOR_CSV_BYTES = 1_000_000;

export function honorCsvTemplate() {
  return toCsv([[...HONOR_CSV_HEADERS]]);
}

export type HonorCsvRow = { line: number; code: string; name: string; description?: string; isActive?: boolean; problems: string[] };

export class HonorCsvError extends Error {}

const clean = (value: string | undefined) => (value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();

export function parseHonorCsv(text: string): HonorCsvRow[] {
  if (text.length > MAX_HONOR_CSV_BYTES) throw new HonorCsvError("That file is too large. Import up to 2,000 honors at a time.");
  const matrix = parseCsvMatrix(text.replace(/^﻿/, ""));
  if (matrix.length === 0) throw new HonorCsvError("That file is empty. Download the template and fill it in.");
  const headers = matrix[0].map((header) => header.toLowerCase().replace(/[^a-z]/g, ""));
  const column = (...names: string[]) => headers.findIndex((header) => names.includes(header));
  const code = column("code", "honorcode", "number");
  const name = column("name", "honor", "honorname");
  const description = column("description");
  const active = column("active", "isactive");
  if (code < 0 || name < 0) throw new HonorCsvError("The first row needs the column names from the template, including Code and Name.");
  const body = matrix.slice(1);
  if (body.length > MAX_HONOR_CSV_ROWS) throw new HonorCsvError("Import up to 2,000 honors at a time.");

  return body.map((cells, index) => {
    const row: HonorCsvRow = {
      line: index + 2,
      code: normalizeHonorCode(clean(cells[code])).slice(0, 40),
      name: clean(cells[name]).slice(0, 120),
      problems: [],
    };
    if (description >= 0 && clean(cells[description])) row.description = (cells[description] ?? "").trim().slice(0, 2000);
    if (active >= 0 && clean(cells[active])) {
      const value = clean(cells[active]).toLowerCase();
      if (["yes", "y", "true", "1", "active"].includes(value)) row.isActive = true;
      else if (["no", "n", "false", "0", "inactive"].includes(value)) row.isActive = false;
      else row.problems.push(`Active "${clean(cells[active])}" should be Yes or No.`);
    }
    if (!row.code) row.problems.push("Every honor needs a code.");
    if (!row.name) row.problems.push("Every honor needs a name.");
    return row;
  });
}

export type HonorImportStep = {
  line: number;
  name: string;
  action: "ADD" | "UPDATE" | "SKIP";
  honorId: string | null;
  message: string;
  row: HonorCsvRow;
};

type ExistingHonor = { id: string; code: string; name: string; description: string; isActive: boolean };

export function planHonorImport(rows: readonly HonorCsvRow[], existing: readonly ExistingHonor[]) {
  const byCode = new Map(existing.map((honor) => [honor.code, honor]));
  const seen = new Set<string>();
  return rows.map((row): HonorImportStep => {
    const name = row.code ? `${row.name} (${row.code})` : row.name;
    const skip = (message: string, honorId: string | null = null): HonorImportStep => ({ line: row.line, name, action: "SKIP", honorId, message, row });
    if (row.problems.length > 0) return skip(row.problems.join(" "));
    if (seen.has(row.code)) return skip("This code is already earlier in the file.");
    seen.add(row.code);
    const honor = byCode.get(row.code);
    if (!honor) return { line: row.line, name, action: "ADD", honorId: null, message: "Will be added.", row };
    const changed = honor.name !== row.name
      || (row.description !== undefined && row.description !== honor.description)
      || (row.isActive !== undefined && row.isActive !== honor.isActive);
    if (!changed) return skip("Already in the catalog; nothing to change.", honor.id);
    return { line: row.line, name, action: "UPDATE", honorId: honor.id, message: "Will update the name, description, or active setting.", row };
  });
}
