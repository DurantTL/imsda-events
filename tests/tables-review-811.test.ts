import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HonorPillList } from "@/components/honor-pill-list";
import { HonorsPrintReport } from "@/components/honors-print-report";
import type { CurrentMemberHonor } from "@/modules/honors/member-honor-domain";

/**
 * Table review (#811), synthetic data only: the honor pills keep their status in a span of its
 * own, the printed honors report copes with any number of honors, and the stylesheet keeps the
 * rules these depend on.
 */

const root = path.resolve(__dirname, "..");
const css = readFileSync(path.join(root, "app/globals.css"), "utf8");

const honors = (count: number): CurrentMemberHonor[] =>
  Array.from({ length: count }, (_, index) => ({
    honorId: `honor-${index}`,
    honorCode: `SYN-${index}`,
    honorName: `Synthetic honor number ${index} with a deliberately long name for wrapping ${"x".repeat(index % 7 === 0 ? 70 : 0)}`,
    status: index % 3 === 0 ? "IN_PROGRESS" : "COMPLETED",
    completionDate: index % 3 === 0 ? "" : "2026-08-15",
    createdAt: "2026-08-15",
  }));

describe("honor pills (#811)", () => {
  it("puts the status in its own span, never inside the (ellipsised) name", () => {
    const html = renderToStaticMarkup(createElement(HonorPillList, { honors: honors(3), showStatus: true }));
    expect(html).toContain('<span class="honor-pill-status">In progress</span>');
    expect(html).toContain('<span class="honor-pill-status">Completed</span>');
    // The name span holds the name only.
    expect(html).not.toMatch(/honor-pill-text">[^<]*(In progress|Completed)/);
  });

  it("leaves the status out where the roster-style compact form is used", () => {
    const html = renderToStaticMarkup(createElement(HonorPillList, { honors: honors(2) }));
    expect(html).not.toContain("honor-pill-status");
  });

  it("keeps every pill in the page for any count, hiding only the ones past the first few", () => {
    const html = renderToStaticMarkup(createElement(HonorPillList, { honors: honors(40), showStatus: true }));
    expect(html.match(/class="status-chip honor-pill/g)).toHaveLength(40);
    expect(html).toContain("Show all (40)");
  });

  it("styles the status as a part that never shrinks, and gives the Honors table fixed column widths", () => {
    expect(css).toMatch(/\.honor-pill-status\s*\{[^}]*flex:\s*0 0 auto/);
    expect(css).toMatch(/\.honors-table\s*\{[^}]*table-layout:\s*fixed/);
    expect(css).toMatch(/\.honors-table \.honors-col-honors|\.honors-table td\.honors-col-honors/);
  });
});

describe("the printed honors report copes with any number of honors (#811)", () => {
  it("lists every honor of a large club once, under one header row", () => {
    const counts = Array.from({ length: 600 }, (_, index) => ({ honorName: `Synthetic honor ${index} ${"long ".repeat(20)}`, count: (index % 9) + 1 }));
    const html = renderToStaticMarkup(createElement(HonorsPrintReport, { clubName: "Synthetic Club", clubYear: "2026-2027", honors: counts, scope: "CLUB" }));
    expect(html.match(/<tr>/g)).toHaveLength(601);
    expect(html.match(/<thead>/g)).toHaveLength(1);
    expect(html).toContain("Synthetic honor 599");
  });

  it("lists every completed honor of one member, and a dated or undated row each", () => {
    const completed = Array.from({ length: 150 }, (_, index) => ({ honorName: `Synthetic honor ${index}`, completionDate: index % 2 ? "2026-08-15" : "" }));
    const html = renderToStaticMarkup(createElement(HonorsPrintReport, { clubName: "Synthetic Club", clubYear: "2026-2027", honors: completed, memberLabel: "Synthetic, Pat", scope: "MEMBER" }));
    expect(html.match(/<tr>/g)).toHaveLength(151);
    expect(html).toContain("No date");
  });

  it("repeats the header row on every printed page and never splits a row", () => {
    expect(css).toMatch(/@media print\s*\{[^@]*\.honors-report-table thead\s*\{[^}]*table-header-group/);
    expect(css).toMatch(/\.honors-report-table tr\s*\{[^}]*break-inside:\s*avoid/);
  });
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("sort controls state the order they set (#811)", () => {
  it("every file with a sortable header or sort link also shows a sort-order note", () => {
    const files = [...sourceFiles(path.join(root, "app")), ...sourceFiles(path.join(root, "components"))];
    const missing = files
      .filter((file) => !file.endsWith("list-sort.tsx") && !file.endsWith("phone-hidden-sort-link.tsx"))
      .filter((file) => /<SortableHeader|<PhoneHiddenSortLink/.test(readFileSync(file, "utf8")))
      .filter((file) => !readFileSync(file, "utf8").includes("<SortOrderNote"))
      .map((file) => path.relative(root, file));
    expect(missing).toEqual([]);
  });
});

describe("every table carries a style that gives its cells padding (#811)", () => {
  // A table with no class has no cell padding at all, which ran "CONFIRMED" into the name beside it (I4).
  const styledClasses = ["report-table", "editable-settings-table", "guardian-review-table", "reminder-recipient-table", "club-form-roll-table", "printTable"];
  // Styled through their container's own rules (the CSS selector named here), not a class on the table.
  const styledByAncestor: Record<string, string> = {
    "components/check-in-book.tsx": ".check-in-book-page table",
    "app/(workspace)/more/reports/packets/page.tsx": ".retreat-packet-sheet table",
  };

  it("has a base class on every table in the app and components", () => {
    const files = [...sourceFiles(path.join(root, "app")), ...sourceFiles(path.join(root, "components"))];
    const unstyled: string[] = [];
    for (const file of files) {
      const relative = path.relative(root, file);
      if (styledByAncestor[relative]) continue;
      for (const match of readFileSync(file, "utf8").matchAll(/<table\b([^>]*)>/g)) {
        if (!styledClasses.some((name) => match[1].includes(name))) unstyled.push(`${relative}: <table${match[1]}>`);
      }
    }
    expect(unstyled).toEqual([]);
  });

  it("the ancestor-styled tables still have their rule", () => {
    for (const selector of Object.values(styledByAncestor)) expect(css).toContain(selector);
  });
});
