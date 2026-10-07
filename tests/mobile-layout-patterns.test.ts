import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static checks of the phone layout patterns (#447, docs/RESPONSIVE.md): the
 * three tables that became cards keep their labels, a row header and the
 * `table-cards` opt-in, and the 44px rules sit in the phone media query. The
 * real-browser audit (scripts/verify-mobile-layout.ts) is the other half.
 */
const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

const attendeeListing = read("app/(workspace)/people/attendees/page.tsx");
const honors = read("components/club-honors-workspace.tsx");
const clubForms = read("app/(workspace)/admin/club-forms/page.tsx");
const css = read("app/globals.css");

/** The text of the `@media` block (its prelude and body) that encloses `needle`, or null at top level. */
function enclosingMedia(source: string, needle: string): string | null {
  const at = source.indexOf(needle);
  if (at < 0) throw new Error(`not found: ${needle}`);
  let depth = 0;
  for (let i = at; i >= 0; i -= 1) {
    const char = source[i];
    if (char === "}") depth += 1;
    if (char === "{") {
      if (depth === 0) {
        const prelude = source.slice(source.lastIndexOf("\n", i) + 1, i).trim();
        if (prelude.startsWith("@media")) return prelude;
        // A plain rule's brace: keep walking out to the block around it.
        continue;
      }
      depth -= 1;
    }
  }
  return null;
}

describe("tables that became phone cards (#447)", () => {
  it("the attendee listing is a table-cards table with labelled cells and the name as row header", () => {
    expect(attendeeListing).toContain('role="table" className="report-table table-cards attendee-listing-table"');
    expect(attendeeListing).toContain("{...cardCell(column.label)}");
    expect(attendeeListing).toMatch(/column\.key === "name"\s*\?\s*<th key=\{column\.key\} role="rowheader" scope="row">/);
    expect(attendeeListing).toContain('role="columnheader"');
  });

  it("the attendee listing gives a phone Sort and Direction, a sort note, and no stray Tab stops", () => {
    expect(attendeeListing).toContain('className="attendee-sort-phone"');
    expect(attendeeListing).toContain('<select name="sort"');
    expect(attendeeListing).toContain('<select name="dir"');
    expect(attendeeListing).toContain("<SortOrderNote>");
    expect(attendeeListing).toContain("<PhoneHiddenSortLink");
    expect(read("components/phone-hidden-sort-link.tsx")).toContain("tabIndex={onPhone ? -1 : undefined}");
    expect(enclosingMedia(css, ".attendee-sort-phone { display: contents; }")).toBe("@media screen and (max-width: 600px)");
  });

  it("the club honors table is table-cards with labelled cells and the member as row header", () => {
    expect(honors).toContain('className="report-table table-cards honors-table" data-fit-width role="table"');
    expect(honors).toContain('cardCell("Current class")');
    expect(honors).toContain('cardCell("Honors")');
    expect(honors).toContain('<th role="rowheader" scope="row"><strong translate="no">');
    // Header and cell counts line up: Name, Current class, Honors, Add. No Select column: the bulk popup does the selecting (#819).
    const head = honors.slice(honors.indexOf("<thead"), honors.indexOf("</thead>"));
    expect((head.match(/<th\b|<SortableHeader/g) ?? []).length).toBe(4);
    const body = honors.slice(honors.indexOf("<tbody"), honors.indexOf("</tbody>"));
    expect((body.match(/<td\b|<th\b/g) ?? []).length).toBe(4);
    expect(body).not.toContain("checkbox-hit");
    expect(head).not.toContain("Select");
  });

  it("the admin club forms table is table-cards with labelled cells and the form as row header", () => {
    expect(clubForms).toContain('role="table" className="report-table table-cards"');
    for (const label of ["Status", "Filled in", "Version"]) expect(clubForms).toContain(`cardCell("${label}")`);
    expect(clubForms).toContain("cardCell(null)");
    expect(clubForms).toContain('<th role="rowheader" scope="row">{template.name}');
  });
});

describe("the 44px phone rules sit inside the phone media query (#447)", () => {
  const phone = "@media screen and (max-width: 600px)";

  it.each([
    [':root summary { min-height: var(--touch-target, 44px); }'],
    [':root :is(td, th) > a:not(.primary-button, .secondary-button) {'],
    [':root .table-sort-button { min-height: var(--touch-target, 44px); }'],
    [':root input[type="color"] { min-width: var(--touch-target, 44px); min-height: var(--touch-target, 44px); }'],
    [':root .checkbox-hit { min-width: var(--touch-target, 44px); min-height: var(--touch-target, 44px); }'],
    ["[type=\"range\"], [type=\"submit\"], [type=\"button\"], [type=\"image\"], [type=\"reset\"]), select, textarea) {"],
  ])("%s", (rule) => {
    expect(enclosingMedia(css, rule)).toBe(phone);
  });

  it("a long-option select cap is a phone-and-tablet rule, not a global one", () => {
    expect(enclosingMedia(css, "  select { max-width: 100%; }")).toBe("@media screen and (max-width: 768px)");
  });
});
