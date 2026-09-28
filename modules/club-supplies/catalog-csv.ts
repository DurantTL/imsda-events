import { createHash } from "node:crypto";
import {
  ADVANCED_HONOR_STAR_CATALOG_NUMBER,
  type ClubSupplySection,
  extractSizeLabel,
  honorCategoryForSection,
  isAdvancedHonorName,
  normalizeClubSupplyName,
  resolveClubSupplySection,
} from "@/modules/club-supplies/domain";
import type { HonorCategory } from "@/modules/honors/domain";
import { CsvImportError, parseCsvMatrix } from "@/modules/imports/csv-parser";
import { toCsv } from "@/modules/reporting/csv";

/**
 * Club supply catalog CSV import (#531). The columns match
 * `docs/reference/adventsource-club-catalog.csv` (section, item, AdventSource
 * catalog number), plus an optional Active column. Every row becomes a
 * `ClubSupplyItem`, matched by section plus normalized name. The dry run
 * returns a fingerprint of the plan and the catalog it was planned against;
 * the confirm step must echo it back.
 */

export const CLUB_SUPPLY_CSV_HEADERS = ["Section", "Item", "Catalog Number", "Active"] as const;
export const MAX_CLUB_SUPPLY_CSV_ROWS = 2000;
export const MAX_CLUB_SUPPLY_CSV_BYTES = 1_000_000;

export function clubSupplyCsvTemplate() {
  return toCsv([[...CLUB_SUPPLY_CSV_HEADERS]]);
}

export class ClubSupplyCsvError extends Error {}

const clean = (value: string | undefined) => (value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();

export type ClubSupplyCsvRow = {
  line: number;
  rawSection: string;
  section: ClubSupplySection | null;
  name: string;
  normalizedName: string;
  catalogNumber: string | null;
  sizeLabel: string | null;
  /** Only set when the file has an Active column and this row fills it. */
  isActive?: boolean;
  problems: string[];
};

export function parseClubSupplyCsv(text: string): ClubSupplyCsvRow[] {
  if (text.length > MAX_CLUB_SUPPLY_CSV_BYTES) {
    throw new ClubSupplyCsvError("That file is too large. Import up to 2,000 rows at a time.");
  }
  let matrix: string[][];
  try {
    matrix = parseCsvMatrix(text.replace(/^﻿/, ""));
  } catch (error) {
    if (error instanceof CsvImportError) throw new ClubSupplyCsvError("That file is empty. Download the template and fill it in.");
    throw error;
  }
  if (matrix.length === 0) throw new ClubSupplyCsvError("That file is empty. Download the template and fill it in.");
  const headers = matrix[0].map((header) => header.toLowerCase().replace(/[^a-z]/g, ""));
  const column = (...names: string[]) => headers.findIndex((header) => names.includes(header));
  const section = column("section");
  const item = column("item", "itemname", "name");
  const catalogNumber = column("catalognumber", "adventsourcecatalognumber", "adventsourcenumber", "number");
  const active = column("active", "isactive");
  if (section < 0 || item < 0) {
    throw new ClubSupplyCsvError("The first row needs the column names from the template, including Section and Item.");
  }
  // `parseCsvMatrix` already leaves out blank lines, as every CSV import here does.
  const body = matrix.slice(1).map((cells, index) => ({ cells, line: index + 2 }));
  if (body.length > MAX_CLUB_SUPPLY_CSV_ROWS) throw new ClubSupplyCsvError("Import up to 2,000 rows at a time.");

  return body.map(({ cells, line }): ClubSupplyCsvRow => {
    const rawSection = clean(cells[section]);
    const name = clean(cells[item]).slice(0, 200);
    const resolved = rawSection ? resolveClubSupplySection(rawSection) : null;
    let number = catalogNumber >= 0 ? clean(cells[catalogNumber]) || null : null;
    const problems: string[] = [];
    if (!rawSection) problems.push("Every row needs a section.");
    else if (!resolved) problems.push(`"${rawSection}" isn't a section this catalog recognizes.`);
    if (!name) problems.push("Every row needs an item name.");
    if (number && !/^[A-Za-z0-9-]{1,40}$/.test(number)) problems.push(`Catalog number "${number}" should be letters, digits, or dashes.`);
    // Every "X - Advanced" honor is ordered as the Advanced Honor Star.
    if (!number && resolved && honorCategoryForSection(resolved) && isAdvancedHonorName(name)) {
      number = ADVANCED_HONOR_STAR_CATALOG_NUMBER;
    }
    const row: ClubSupplyCsvRow = {
      line,
      rawSection,
      section: resolved,
      name,
      normalizedName: normalizeClubSupplyName(name),
      catalogNumber: number,
      sizeLabel: extractSizeLabel(name),
      problems,
    };
    if (active >= 0 && clean(cells[active])) {
      const value = clean(cells[active]).toLowerCase();
      if (["yes", "y", "true", "1", "active"].includes(value)) row.isActive = true;
      else if (["no", "n", "false", "0", "inactive"].includes(value)) row.isActive = false;
      else problems.push(`Active "${clean(cells[active])}" should be Yes or No.`);
    }
    return row;
  });
}

export type ExistingClubSupplyItem = {
  id: string;
  section: ClubSupplySection;
  name: string;
  normalizedName: string;
  catalogNumber: string | null;
  sizeLabel: string | null;
  isActive: boolean;
  honorId: string | null;
  updatedAt: Date | string;
};

export type ExistingCatalogHonor = {
  id: string;
  code: string;
  name: string;
  catalogNumber: string | null;
  category: HonorCategory | null;
  updatedAt: Date | string;
};

export type ClubSupplyImportAction = "ADD" | "UPDATE" | "SKIP";

export type ClubSupplyImportStep = {
  line: number;
  name: string;
  action: ClubSupplyImportAction;
  message: string;
  section: ClubSupplySection | null;
  normalizedName: string;
  itemId: string | null;
  /** What the item is saved as (ADD and UPDATE only). */
  write: {
    section: ClubSupplySection;
    name: string;
    normalizedName: string;
    catalogNumber: string | null;
    sizeLabel: string | null;
    isActive: boolean;
    honorId: string | null;
  } | null;
  /** Honor-section rows: whether the name matched an existing `Honor`. */
  honorMatch: "MATCHED" | "UNMATCHED" | null;
  /** The honor fields to set, when a linked honor's number or category differs. */
  honorUpdate: { honorId: string; catalogNumber: string | null; category: HonorCategory } | null;
  /** The earlier line this row repeats (same section and normalized name). */
  duplicateOfLine: number | null;
};

export type RepeatedCatalogNumber = { catalogNumber: string; count: number; lines: number[] };

export type ClubSupplyImportSummary = {
  rows: number;
  added: number;
  updated: number;
  skipped: number;
  duplicates: number;
  problems: number;
  honorsMatched: number;
  honorsUnmatched: number;
  honorsUpdated: number;
  repeatedNumbers: number;
};

export type ClubSupplyImportPlan = {
  steps: ClubSupplyImportStep[];
  summary: ClubSupplyImportSummary;
  repeatedNumbers: RepeatedCatalogNumber[];
};

const key = (section: string, normalizedName: string) => `${section}\u0000${normalizedName}`;

/**
 * Plans an import (#531). A row matches an existing item by section plus
 * normalized name; within the file a repeat of the same pair is merged into
 * the first (the source repeats some PBE pins). An honor-section row links to
 * the honor whose normalized name matches, and sets that honor's catalog
 * number and category; an unmatched honor row stays an unlinked item and is
 * counted. A catalog number used by more than one item is only a warning.
 */
export function planClubSupplyImport(
  rows: readonly ClubSupplyCsvRow[],
  existingItems: readonly ExistingClubSupplyItem[],
  existingHonors: readonly ExistingCatalogHonor[],
): ClubSupplyImportPlan {
  const itemsByKey = new Map(existingItems.map((item) => [key(item.section, item.normalizedName), item]));
  const honorsByName = new Map<string, ExistingCatalogHonor>();
  for (const honor of [...existingHonors].sort((a, b) => a.code.localeCompare(b.code))) {
    const name = normalizeClubSupplyName(honor.name);
    if (!honorsByName.has(name)) honorsByName.set(name, honor);
  }
  const firstLineByKey = new Map<string, number>();
  const plannedHonorUpdates = new Set<string>();
  const linesByNumber = new Map<string, number[]>();

  const steps = rows.map((row): ClubSupplyImportStep => {
    const base = {
      line: row.line,
      name: row.name || row.rawSection,
      section: row.section,
      normalizedName: row.normalizedName,
      itemId: null,
      write: null,
      honorMatch: null,
      honorUpdate: null,
      duplicateOfLine: null,
    };
    if (row.problems.length > 0 || !row.section) {
      return { ...base, action: "SKIP", message: row.problems.join(" ") || "Unrecognized section." };
    }
    const section = row.section;
    const rowKey = key(section, row.normalizedName);
    const earlier = firstLineByKey.get(rowKey);
    const existing = itemsByKey.get(rowKey) ?? null;
    if (earlier !== undefined) {
      return {
        ...base,
        itemId: existing?.id ?? null,
        action: "SKIP",
        message: `Same item as row ${earlier}; merged into it.`,
        duplicateOfLine: earlier,
      };
    }
    firstLineByKey.set(rowKey, row.line);
    if (row.catalogNumber) linesByNumber.set(row.catalogNumber, [...(linesByNumber.get(row.catalogNumber) ?? []), row.line]);

    const category = honorCategoryForSection(section);
    const honor = category ? honorsByName.get(row.normalizedName) ?? null : null;
    const honorMatch = category ? (honor ? "MATCHED" : "UNMATCHED") : null;
    let honorUpdate: ClubSupplyImportStep["honorUpdate"] = null;
    if (honor && category && !plannedHonorUpdates.has(honor.id)) {
      const catalogNumber = row.catalogNumber ?? honor.catalogNumber;
      if (honor.catalogNumber !== catalogNumber || honor.category !== category) {
        honorUpdate = { honorId: honor.id, catalogNumber, category };
        plannedHonorUpdates.add(honor.id);
      }
    }
    const write = {
      section,
      name: row.name,
      normalizedName: row.normalizedName,
      catalogNumber: row.catalogNumber,
      sizeLabel: row.sizeLabel,
      isActive: row.isActive ?? existing?.isActive ?? true,
      honorId: honor?.id ?? null,
    };
    const honorNote = honorUpdate ? " Sets the honor's catalog number and category." : "";
    const honorLabel = honorMatch === "MATCHED" ? " Linked to its honor." : honorMatch === "UNMATCHED" ? " No matching honor; left unlinked." : "";
    if (!existing) {
      return { ...base, action: "ADD", message: `Will be added.${honorLabel}${honorNote}`, write, honorMatch, honorUpdate };
    }
    const changed = existing.name !== write.name
      || existing.catalogNumber !== write.catalogNumber
      || existing.sizeLabel !== write.sizeLabel
      || existing.isActive !== write.isActive
      || existing.honorId !== write.honorId;
    if (!changed && !honorUpdate) {
      return { ...base, itemId: existing.id, action: "SKIP", message: `Already in the catalog; nothing to change.${honorLabel}`, honorMatch };
    }
    return {
      ...base,
      itemId: existing.id,
      action: "UPDATE",
      message: `Will update this item.${honorLabel}${honorNote}`,
      write,
      honorMatch,
      honorUpdate,
    };
  });

  const repeatedNumbers = [...linesByNumber.entries()]
    .filter(([, lines]) => lines.length > 1)
    .map(([catalogNumber, lines]) => ({ catalogNumber, count: lines.length, lines }));
  const count = (predicate: (step: ClubSupplyImportStep) => boolean) => steps.filter(predicate).length;
  const summary: ClubSupplyImportSummary = {
    rows: steps.length,
    added: count((step) => step.action === "ADD"),
    updated: count((step) => step.action === "UPDATE"),
    skipped: count((step) => step.action === "SKIP"),
    duplicates: count((step) => step.duplicateOfLine !== null),
    problems: rows.filter((row) => row.problems.length > 0 || !row.section).length,
    honorsMatched: count((step) => step.honorMatch === "MATCHED"),
    honorsUnmatched: count((step) => step.honorMatch === "UNMATCHED"),
    honorsUpdated: count((step) => step.honorUpdate !== null),
    repeatedNumbers: repeatedNumbers.length,
  };
  return { steps, summary, repeatedNumbers };
}

const iso = (value: Date | string) => (value instanceof Date ? value.toISOString() : value);

/**
 * A hash of the plan plus the catalog state it was planned against (#531).
 * The dry run returns it; the confirm step must send it back, so a file that
 * changed, or a catalog someone else changed in between, is refused.
 */
export function clubSupplyImportFingerprint(
  plan: ClubSupplyImportPlan,
  existingItems: readonly ExistingClubSupplyItem[],
  existingHonors: readonly ExistingCatalogHonor[],
) {
  const state = {
    plan: plan.steps.map((step) => [step.line, step.action, step.itemId, step.write, step.honorUpdate, step.duplicateOfLine]),
    items: [...existingItems]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((item) => [item.id, item.section, item.normalizedName, item.name, item.catalogNumber, item.sizeLabel, item.isActive, item.honorId, iso(item.updatedAt)]),
    honors: [...existingHonors]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((honor) => [honor.id, honor.code, honor.name, honor.catalogNumber, honor.category, iso(honor.updatedAt)]),
  };
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}
