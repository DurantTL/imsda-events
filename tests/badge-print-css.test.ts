import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  badgePrintPageRule,
  badgeTemplateIds,
  badgeTemplates,
} from "@/modules/checkin/badge-labels";

const css = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");

/** The body of the last top-level `@media print { ... }` block that mentions the badge sheets. */
function badgePrintBlock() {
  let found = "";
  for (const match of css.matchAll(/@media print\s*\{/g)) {
    let depth = 1;
    let index = (match.index ?? 0) + match[0].length;
    const start = index;
    while (depth > 0 && index < css.length) {
      if (css[index] === "{") depth += 1;
      if (css[index] === "}") depth -= 1;
      index += 1;
    }
    const block = css.slice(start, index - 1);
    if (block.includes(".badge-sheet")) found = block;
  }
  return found;
}

/** Declarations of the first rule in `block` whose selector list is exactly `selector`. */
function declarationsFor(block: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\>:]/g, "\\$&");
  const match = block.match(new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

describe("badge print CSS (#717)", () => {
  const block = badgePrintBlock();

  it("finds the badge print rules", () => {
    expect(block).not.toBe("");
  });

  it("hides the page chrome that must never reach a label sheet", () => {
    const hidden = block.match(/([^{}]+)\{\s*display:\s*none\s*!important;?\s*\}/g)?.join(",") ?? "";
    for (const selector of [
      ".sidebar",
      ".workspace-header",
      ".mobile-nav",
      ".skip-link",
      ".act-as-banner",
      ".event-auto-select-notice",
      ".badge-print-intro",
      ".badge-print-controls",
      ".badge-print-summary",
    ]) {
      expect(hidden, selector).toContain(selector);
    }
  });

  it("hides every badge page child except the sheet stack (artwork panel, status and help text)", () => {
    expect(block).toContain(".badge-print-page > :not(.badge-sheet-stack)");
  });

  it("starts each sheet on its own page without splitting or trailing blank pages", () => {
    const sheet = declarationsFor(block, ".badge-sheet");
    expect(sheet).toMatch(/break-after:\s*page/);
    expect(sheet).toMatch(/break-inside:\s*avoid/);
    expect(sheet).toMatch(/margin:\s*0/);
    expect(declarationsFor(block, ".badge-sheet:last-child")).toMatch(/break-after:\s*auto/);
  });

  it("leaves no padding, gap or minimum height ahead of sheet 1", () => {
    expect(declarationsFor(block, ".badge-print-page")).toMatch(/padding:\s*0/);
    expect(declarationsFor(block, ".badge-sheet-stack")).toMatch(/padding:\s*0/);
    expect(declarationsFor(block, ".badge-sheet-stack")).toMatch(/gap:\s*0/);
    expect(block).toMatch(/\.app-shell,\s*body\s*\{\s*min-height:\s*0/);
  });

  it("uses a zero-margin portrait letter page, never the browser's margins", () => {
    expect(badgePrintPageRule).toBe("@page { size: letter portrait; margin: 0; }");
  });

  it("keeps each template's sheet at full letter size with its own margins as padding", () => {
    expect(css).toMatch(/\.badge-sheet\s*\{[^}]*width:\s*8\.5in;[^}]*height:\s*11in;/);
    const presta = css.match(/\.badge-sheet-avery-presta-94237\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(presta).toMatch(/--sheet-pad-top:\s*1in/);
    expect(presta).toMatch(/--sheet-pad-left:\s*0\.85in/);
    expect(presta).toMatch(/--col-gap:\s*0\.8in/);
    expect(presta).toMatch(/--row-gap:\s*0\.333333in/);
    expect(presta).toMatch(/grid-template-columns:\s*repeat\(2,\s*3in\)/);
    expect(presta).toMatch(/grid-template-rows:\s*repeat\(4,\s*2in\)/);
  });

  it("has a sheet layout for every badge template", () => {
    for (const id of badgeTemplateIds) {
      expect(css, id).toContain(`.badge-sheet-${id}`);
      expect(badgeTemplates[id].perSheet).toBeGreaterThan(0);
    }
  });
});
