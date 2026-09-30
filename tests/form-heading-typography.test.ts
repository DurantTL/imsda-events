import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Issue #645: one heading scale and a helper-text floor for public
// registration forms, Honors Weekend and the club portal. Vitest has no layout
// engine, so these guard the stylesheet; the rendered check (computed sizes and
// overflow at 360/390/768/1280 and 200% text) is recorded in the pull request.
const css = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const scoped = /\.(public-(registration|manage|event)-|club-(class|home|year|roster|registration|guest|going|invite|team|schedule|assignment|overview|order))/;
const excluded = /club-packet|club-check-in|club-reports|club-form-|public-attendee|public-payment|public-square|public-shirt|attendee-hub|attendee-community/;
// Counters and badges (not helper text): sized with --text-badge and em boxes.
const badges = [
  ".public-registration-progress li > span",
  ".public-registration-section > header > span",
  ".public-registration-roster-heading > span:first-child",
  ".public-registration-attendee-number",
  ".public-event-form-number",
  ".public-registration-secure",
  ".public-registration-roster-heading > strong",
  ".public-registration-ranking-list button > b",
  ".public-event-status",
  ".public-registration-code small",
  ".public-manage-status small",
];

function token(name: string) {
  const match = css.match(new RegExp(`${name}:\\s*([\\d.]+)rem`));
  expect(match, name).not.toBeNull();
  return Number(match![1]);
}

function rules() {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((rule) => ({ selector: rule[1].trim(), body: rule[2] }));
}

describe("heading scale and helper text (issue #645)", () => {
  it("defines the scale in order, with helper text no smaller than 0.875rem", () => {
    expect(token("--text-helper-min")).toBeGreaterThanOrEqual(0.875);
    expect(token("--text-badge")).toBeGreaterThanOrEqual(0.75);
    expect(token("--text-badge")).toBeLessThan(token("--text-helper-min"));
    expect(token("--heading-section")).toBeGreaterThan(token("--heading-sub"));
    expect(token("--heading-sub")).toBeGreaterThan(token("--heading-group"));
    expect(token("--heading-group")).toBeGreaterThanOrEqual(1);
    expect(token("--heading-space-above")).toBeGreaterThan(token("--heading-gap"));
    expect(token("--heading-gap") * 16).toBeGreaterThanOrEqual(8);
  });

  it("sets no literal font size under 0.875rem on form, honors or club portal text", () => {
    const offenders: string[] = [];
    for (const { selector, body } of rules()) {
      if (selector.startsWith("@") || !scoped.test(selector) || excluded.test(selector)) continue;
      if (selector.split(",").every((part) => badges.some((badge) => part.trim().endsWith(badge)))) continue;
      for (const size of body.matchAll(/font-size:\s*([\d.]+)rem/g)) {
        if (Number(size[1]) < 0.875) offenders.push(`${selector} { font-size: ${size[1]}rem }`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("sizes badge and counter boxes in em so they grow with text zoom", () => {
    const fixed: string[] = [];
    for (const { selector, body } of rules()) {
      if (!selector.split(",").every((part) => badges.some((badge) => part.trim().endsWith(badge)))) continue;
      if (/(?<![-\w])(width|height):\s*[\d.]+px/.test(body)) fixed.push(selector);
    }
    expect(fixed).toEqual([]);
  });

  it("leaves global and staff-only text classes alone", () => {
    expect(css).toContain(".field-help { margin: -9px 0 0; color: var(--muted); font-size: 0.63rem; }");
    expect(css).toMatch(/\.club-form-answers dt \{[^}]*font-size: 0\.68rem/);
    expect(css).toMatch(/\.account-system-link \{[^}]*font-size: 0\.68rem/);
  });
});
