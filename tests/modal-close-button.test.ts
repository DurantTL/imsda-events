import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? sources(full) : full.endsWith(".tsx") ? [full] : [];
});

describe("popup close buttons", () => {
  it("every Close button uses the shared modal-close-button style", () => {
    const missing: string[] = [];
    for (const file of [...sources("components"), ...sources("app")]) {
      const source = readFileSync(file, "utf8");
      // Whole elements, so an arrow function (`=>`) before the label or the class can't end the match early.
      for (const match of source.matchAll(/<button\b[\s\S]*?<\/button>/g)) {
        if (!/aria-label=\{?["`]Close/.test(match[0])) continue;
        if (!match[0].includes("modal-close-button")) missing.push(`${file}: ${match[0].slice(0, 80)}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("gives the button a visible 3:1 edge, hover and focus states, a 44px phone target, and a centred ×", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/\.modal-close-button \{[^}]*flex: 0 0 auto;[^}]*border-color: #6f8794/);
    expect(css).toMatch(/\.modal-close-button:hover:not\(:disabled\) \{[^}]*border-color: var\(--imsda-navy\)/);
    expect(css).toMatch(/\.modal-close-button:focus-visible \{[^}]*outline: 3px solid var\(--imsda-navy\)/);
    expect(css).toMatch(/\.modal-close-button \{[^}]*min-width: 44px;[^}]*min-height: 44px/);
    // The gallery follows the public theme: same edge and shape as the others, theme fill and X, themed hover.
    expect(css).toMatch(/\.event-gallery-dialog \.modal-close-button \{[^}]*border-color: #6f8794;[^}]*border-radius: 12px;[^}]*color: var\(--block-accent\)/);
    expect(css).toMatch(/\.event-gallery-dialog \.modal-close-button:hover:not\(:disabled\) \{[^}]*background: var\(--block-soft\)/);
    // The phone rule used to switch the button to inline-flex, which dropped the grid centring and pushed the × left.
    expect(css).not.toMatch(/\.modal-card \.modal-close-button \{ display: inline-flex !important; \}/);
    expect(css).toMatch(/\.modal-card \.modal-close-button \{[^}]*display: inline-grid !important;[^}]*place-items: center/);
  });
});
