import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// These are CSS-only fixes (issue #469). A real browser check (Playwright at
// 390x844 and 360x800, signed in as the seeded local accounts) walked each
// one and is recorded in the pull request; these are regression guards so a
// future edit to app/globals.css cannot silently reintroduce them, since
// Vitest does not run a layout engine that could assert on rendered size.
const globalsCss = readFileSync(
  path.join(process.cwd(), "app/globals.css"),
  "utf8",
);

describe("phone sizing (issue #469)", () => {
  it("forces every text-entry form control to at least 16px on coarse pointers", () => {
    // iOS Safari zooms the page when a focused control renders below 16px.
    // This must apply everywhere (staff, club portal, and public pages share
    // this one stylesheet) while leaving the checked-in desktop look alone,
    // so the rule lives inside @media (pointer: coarse) and reaches ordinary
    // text inputs, selects and textareas regardless of any smaller size set
    // on a more specific selector elsewhere in the file (e.g. the 0.7rem
    // `.filter-field select`), which is why it carries `!important`.
    const coarsePointerBlockMatch = globalsCss.match(
      /@media \(pointer: coarse\) \{([\s\S]*?)\n\}/,
    );
    expect(coarsePointerBlockMatch).not.toBeNull();
    const block = coarsePointerBlockMatch![1];
    expect(block).toContain("select");
    expect(block).toContain("textarea");
    expect(block).toMatch(/font-size:\s*16px\s*!important/);
    // Checkbox/radio/etc. are excluded because font-size does not change
    // their rendered size, so they don't need (or want) this override.
    expect(block).toContain(':not([type="checkbox"])');
    expect(block).toContain(':not([type="radio"])');
  });

  it("keeps the accounts table's scroll container from widening its ancestors", () => {
    // A wide table inside `.report-table-wrap` (overflow-x: auto) must
    // scroll inside that box instead of forcing `.panel`, its grid track,
    // and ultimately the page wider than the device on first paint. Both
    // ends of that containment need `min-width: 0`.
    expect(globalsCss).toMatch(
      /\.report-table-wrap\s*\{[^}]*min-width:\s*0[^}]*\}/,
    );
    expect(globalsCss).toMatch(/\.panel\s*\{[^}]*min-width:\s*0[^}]*\}/);
  });

  it("keeps the public registration step list on one row at phone widths", () => {
    // A fixed 2-column grid wrapped a 3rd step (e.g. "Payment") onto its own
    // row at 360-390px. It must not come back as a fixed column count that
    // breaks for any step count above 2.
    const mobileSection = globalsCss.slice(
      globalsCss.indexOf("@media (max-width: 580px) {\n  .public-submission-detail"),
    );
    const olRuleMatch = mobileSection.match(
      /\.public-registration-progress ol \{([^}]*)\}/,
    );
    expect(olRuleMatch).not.toBeNull();
    expect(olRuleMatch![1]).toContain("display: flex");
    expect(olRuleMatch![1]).not.toMatch(/grid-template-columns/);
  });
});
