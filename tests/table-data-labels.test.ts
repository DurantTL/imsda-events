import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { accountColumnSortKeys, accountSortLabels } from "@/modules/system-admin/account-sort";

/**
 * Static check for the stacked-card tables (#811). On a phone a `<td data-label="X">`
 * is shown as "X: value", so X must be the text of that column's `<th>`. This reads the
 * source of every component and page, finds each `<table>` that labels its cells (with a
 * literal `data-label="..."` or `cardCell("...")`) and checks each label against the
 * header cells of the same table. Labels built at run time (`cardCell(column.label)`) are
 * checked in the browser by `scripts/verify-mobile-layout.ts`, which reads the rendered DOM.
 */

const root = path.resolve(__dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const normalize = (text: string) => text.replace(/<[^>]*>/g, " ").replace(/\{[^}]*\}/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim().toLowerCase();

/** Header texts of one table: `<th>` bodies, and `label="..."` of the sortable header component. */
function headerLabels(tableSource: string): string[] {
  const head = /<thead[\s\S]*?<\/thead>/.exec(tableSource)?.[0] ?? "";
  const labels: string[] = [];
  for (const match of head.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)) labels.push(normalize(match[1]));
  for (const match of head.matchAll(/<SortableHeader\b[^>]*?\blabel="([^"]+)"/g)) labels.push(normalize(match[1]));
  // A string literal inside a header expression, e.g. {active ? "Name ▲" : "Name"}.
  for (const match of head.matchAll(/<th\b[^>]*>\s*\{[^}]*"([^"]+)"[^}]*\}\s*<\/th>/g)) labels.push(normalize(match[1]));
  // Headers built from a label map at run time: read the same map the component reads.
  if (head.includes("accountSortLabels[key]")) for (const key of accountColumnSortKeys) labels.push(normalize(accountSortLabels[key]));
  return labels.filter(Boolean);
}

/** The literal card labels of one table's body cells. */
function cellLabels(tableSource: string): string[] {
  const body = tableSource.replace(/<thead[\s\S]*?<\/thead>/, "");
  const labels: string[] = [];
  for (const match of body.matchAll(/data-label="([^"]+)"/g)) labels.push(match[1]);
  for (const match of body.matchAll(/cardCell\("([^"]+)"\)/g)) labels.push(match[1]);
  return labels;
}

function tables(source: string): string[] {
  return Array.from(source.matchAll(/<table\b[\s\S]*?<\/table>/g), (match) => match[0]);
}

describe("card labels match their column headers", () => {
  const files = [...sourceFiles(path.join(root, "app")), ...sourceFiles(path.join(root, "components"))];

  it("finds the tables this test is about", () => {
    const labelled = files.flatMap((file) => tables(readFileSync(file, "utf8"))).filter((table) => cellLabels(table).length > 0);
    expect(labelled.length).toBeGreaterThan(10);
  });

  it("every literal data-label or cardCell label is the text of a header in the same table", () => {
    const problems: string[] = [];
    for (const file of files) {
      for (const table of tables(readFileSync(file, "utf8"))) {
        const labels = cellLabels(table);
        if (labels.length === 0) continue;
        const headers = headerLabels(table);
        for (const label of new Set(labels)) {
          const wanted = normalize(label);
          // A header may carry extra words ("Honors" over "Honors, newest first"); the label is its start.
          if (!headers.some((header) => header === wanted || header.startsWith(wanted))) {
            problems.push(`${path.relative(root, file)}: data-label "${label}" has no matching header (headers: ${headers.join(" | ") || "none found"})`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("the helper reads headers and labels as intended", () => {
    const sample = `<table><thead><tr><th>Club</th><SortableHeader label="Name" /></tr></thead><tbody><tr><td data-label="Club" /><td {...cardCell("Name")} /></tr></tbody></table>`;
    expect(headerLabels(sample)).toEqual(["club", "name"]);
    expect(cellLabels(sample)).toEqual(["Club", "Name"]);
  });
});
