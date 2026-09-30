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
const badges = new Set([
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
]);

function token(name: string) {
  const match = css.match(new RegExp(`${name}:\\s*([\\d.]+)rem`));
  expect(match, name).not.toBeNull();
  return Number(match![1]);
}

function rules() {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((rule) => ({
    selector: rule[1].trim().replace(/\s+/g, " "),
    body: rule[2],
  }));
}

const parts = (selector: string) => selector.split(",").map((part) => part.trim());
const isBadgeRule = (selector: string) => parts(selector).every((part) => badges.has(part));
const inFamily = (selector: string) => !selector.startsWith("@") && scoped.test(selector) && !excluded.test(selector);

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
      if (!inFamily(selector) || isBadgeRule(selector)) continue;
      for (const size of body.matchAll(/font-size:\s*([\d.]+)rem/g)) {
        if (Number(size[1]) < 0.875) offenders.push(`${selector} { font-size: ${size[1]}rem }`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("gives badge and counter rules var(--text-badge) or at least 0.75rem, sized in em", () => {
    const seen = new Set<string>();
    const bad: string[] = [];
    for (const { selector, body } of rules()) {
      if (!isBadgeRule(selector)) continue;
      parts(selector).forEach((part) => seen.add(part));
      const size = body.match(/font-size:\s*([^;]+)/)?.[1].trim();
      if (size && size !== "0" && size !== "var(--text-badge)" && !(/^[\d.]+rem$/.test(size) && parseFloat(size) >= 0.75)) bad.push(`${selector} { font-size: ${size} }`);
      if (/(?<![-\w])(width|height):\s*[\d.]+px/.test(body)) bad.push(`${selector} uses px width/height`);
    }
    expect(bad).toEqual([]);
    expect([...badges].filter((badge) => !seen.has(badge))).toEqual([]);
  });

  it("leaves every rule outside the public and portal families with its main-branch font size", () => {
    // Snapshot of `selector | font-size` for each rule on main that is not in the
    // families above (staff screens, global helpers, print, the staff club-form
    // viewer). If a later change to one of these is intentional, regenerate the fixture.
    const snapshot = JSON.parse(
      readFileSync(path.join(process.cwd(), "tests/fixtures/globals-non-portal-font-sizes.json"), "utf8"),
    ) as string[];
    const current = new Set<string>();
    for (const { selector, body } of rules()) {
      const size = body.match(/font-size:\s*([^;]+)/)?.[1].trim();
      if (size) current.add(`${selector} | ${size}`);
    }
    expect(snapshot.filter((entry) => !current.has(entry))).toEqual([]);
  });
});
