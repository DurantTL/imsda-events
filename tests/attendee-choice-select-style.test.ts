import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("attendee choice selects look tappable (#711)", () => {
  const form = read("components/attendee-registration-answers-form.tsx");
  const css = read("app/globals.css");

  it("gives the ranked-choice select the shared field class, a placeholder state and a title", () => {
    expect(form).toMatch(/<select[\s\S]*?\s+className=\{`field-select\$\{selected\[rank\] \? "" : " is-empty"\}`\}/);
    expect(form).toContain("title={selected[rank] || undefined}");
    expect(form).toContain('<option value="">Choose…</option>');
  });

  it("keeps the First/Second choice label wrapping its select", () => {
    expect(form).toMatch(/<label key=\{rank\}>\s*<span>\{rank === 0 \? "First choice"/);
  });

  it("styles the field with a border, rounding, 48px height, chevron, muted placeholder and focus ring", () => {
    const block = css.slice(css.indexOf(".field-select {"), css.indexOf(".field-select:disabled"));
    expect(block).toContain("border: 1px solid #7d919b");
    expect(block).toContain("text-overflow: ellipsis");
    expect(block).toContain("white-space: nowrap");
    expect(block).toContain("border-radius: 12px");
    expect(block).toContain("min-height: 48px");
    expect(block).toContain("background-image: url(");
    expect(block).toContain("width: 100%");
    expect(block).toMatch(/\.field-select\.is-empty \{ color: var\(--muted\)/);
    expect(block).toContain(".field-select:focus-visible { border-color: var(--imsda-purple); }");
    expect(block).not.toMatch(/focus-visible \{[^}]*outline/);
  });

  it("keeps the public form's own select rule untouched", () => {
    expect(css).not.toMatch(/\.field-select,\s*\.public-registration-field select/);
  });

  it("shows a long chosen option in full under the select, tied by aria-describedby", () => {
    expect(form).toContain("LONG_OPTION_LENGTH = 38");
    expect(form).toContain("aria-describedby=");
    expect(form).toContain('className="field-select-full-name"');
  });

  it("gives the border at least 3:1 contrast against white", () => {
    const lin = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const [r, g, b] = [0x7d, 0x91, 0x9b];
    const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    expect(1.05 / (luminance + 0.05)).toBeGreaterThanOrEqual(3);
  });
});
