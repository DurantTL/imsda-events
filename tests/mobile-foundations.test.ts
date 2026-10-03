import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Issue #684: phone type floor, contrast, 44px targets and input focus. Vitest has
// no layout engine, so these guard the stylesheet; the rendered measurements at
// 390x844 are recorded in the change notes.
const css = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function luminance(hex: string) {
  const channels = [1, 3, 5].map((index) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground: string, background: string) {
  const [a, b] = [luminance(foreground), luminance(background)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

const declared = (name: string) => css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1] ?? "";

describe("mobile foundations (issue #684)", () => {
  it("keeps the muted text colour and the calendar outside-day colour at 4.5:1 on the tinted panel backgrounds", () => {
    const backgrounds = ["#ffffff", "#f4f7f8", "#e6f0f4", "#f1eaf7"];
    const muted = declared("--muted");
    for (const background of backgrounds) expect(contrast(muted, background), `${muted} on ${background}`).toBeGreaterThanOrEqual(4.5);
    const outside = css.match(/\.calendar-day\.is-outside \.calendar-day-number \{ color: (#[0-9a-fA-F]{6})/)?.[1] ?? "";
    expect(contrast(outside, "#fafcfc")).toBeGreaterThanOrEqual(4.5);
    const nav = css.match(/\.mobile-nav a \{[^}]*?color: (#[0-9a-fA-F]{6})/)?.[1] ?? "";
    expect(contrast(nav, "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("defines the type floors as :root tokens (global since #743: 12px meta, 14px body) and repeats them on phones", () => {
    expect(css).toMatch(/:root \{[^}]*--type-floor: 0\.75rem;[^}]*--type-body-floor: 0\.875rem;/);
    const phone = css.slice(css.lastIndexOf("@media screen and (max-width: 768px)"));
    expect(phone).toMatch(/--type-floor: 0\.75rem;/);
    expect(phone).toMatch(/--type-body-floor: 0\.875rem;/);
    expect(phone).toMatch(/--touch-target: 44px;/);
  });

  it("never writes a literal rem or em font size under 0.75 outside print rules; small sizes go through the floor tokens", () => {
    const offenders: string[] = [];
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const size of rule[2].matchAll(/font-size:\s*([\d.]+)(rem|em)\b/g)) {
        if (Number(size[1]) < 0.75) offenders.push(`${rule[1].trim().replace(/\s+/g, " ")} { font-size: ${size[1]}${size[2]} }`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("gives inputs, selects and textareas one 2px focus outline, and sizes the password toggle and checkbox rows to 44px", () => {
    expect(css).toMatch(/:focus-visible\s*\{\s*outline: 2px solid var\(--imsda-purple\);/);
    const phone = css.slice(css.lastIndexOf("@media screen and (max-width: 768px)"));
    expect(phone).toMatch(/\.password-field button \{[^}]*width: var\(--touch-target\);[^}]*height: var\(--touch-target\);/);
    expect(phone).toMatch(/input\[type="checkbox"\], input\[type="radio"\]\) \{[^}]*width: 22px;[^}]*height: 22px;/);
    expect(phone).toMatch(/\.checkbox-label[^{]*\{\s*min-height: var\(--touch-target\);/);
  });
});
