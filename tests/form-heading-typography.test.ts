import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Issue #645: one heading scale and a helper-text floor for public
// registration forms, Honors Weekend and the club portal. Vitest has no layout
// engine, so these guard the stylesheet; the rendered check (computed sizes and
// overflow at 360/390/768/1280 and 200% text) is recorded in the pull request.
const css = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const scoped = /\.(public-(registration|manage|event)-|club-(class|guest|going|home|year|form|report|invite|roster|team|schedule|assignment|registration|honors|uniform|overview|order)|account-|honor-|field-help\b)/;
const excluded = /club-packet|club-check-in|public-attendee|public-payment|public-square|public-shirt|attendee-hub|attendee-community/;

function token(name: string) {
  const match = css.match(new RegExp(`${name}:\\s*([\\d.]+)rem`));
  expect(match, name).not.toBeNull();
  return Number(match![1]);
}

describe("heading scale and helper text (issue #645)", () => {
  it("defines the scale in order, with helper text no smaller than 0.875rem", () => {
    expect(token("--text-helper-min")).toBeGreaterThanOrEqual(0.875);
    expect(token("--heading-section")).toBeGreaterThan(token("--heading-sub"));
    expect(token("--heading-sub")).toBeGreaterThan(token("--heading-group"));
    expect(token("--heading-group")).toBeGreaterThanOrEqual(1);
    expect(token("--heading-space-above")).toBeGreaterThan(token("--heading-gap"));
    expect(token("--heading-gap") * 16).toBeGreaterThanOrEqual(8);
  });

  it("sets no literal font size under 0.875rem on form, honors or club portal text", () => {
    const offenders: string[] = [];
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = rule[1].trim();
      if (selector.startsWith("@") || !scoped.test(selector) || excluded.test(selector)) continue;
      for (const size of rule[2].matchAll(/font-size:\s*([\d.]+)rem/g)) {
        if (Number(size[1]) < 0.875) offenders.push(`${selector} { font-size: ${size[1]}rem }`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
