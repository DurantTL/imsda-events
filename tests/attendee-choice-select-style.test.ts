import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("attendee choice selects look tappable (#711)", () => {
  const form = read("components/attendee-registration-answers-form.tsx");
  const css = read("app/globals.css");

  it("gives the ranked-choice select the shared field class, a placeholder state and a title", () => {
    expect(form).toMatch(/<select\s+className=\{`field-select\$\{selected\[rank\] \? "" : " is-empty"\}`\}/);
    expect(form).toContain("title={selected[rank] || undefined}");
    expect(form).toContain('<option value="">Choose…</option>');
  });

  it("keeps the First/Second choice label wrapping its select", () => {
    expect(form).toMatch(/<label key=\{rank\}>\s*<span>\{rank === 0 \? "First choice"/);
  });

  it("styles the field with a border, rounding, 48px height, chevron, muted placeholder and focus ring", () => {
    const block = css.slice(css.indexOf(".field-select,"), css.indexOf(".field-select:disabled"));
    expect(block).toContain("border: 1px solid var(--line)");
    expect(block).toContain("border-radius: 12px");
    expect(block).toContain("min-height: 48px");
    expect(block).toContain("background-image: url(");
    expect(block).toContain("width: 100%");
    expect(block).toMatch(/\.field-select\.is-empty \{ color: var\(--muted\)/);
    expect(block).toContain(".field-select:focus-visible");
  });

  it("shares the field style with the public registration form's selects", () => {
    expect(css).toMatch(/\.field-select,\s*\.public-registration-field select \{/);
  });
});
