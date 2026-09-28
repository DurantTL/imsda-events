import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The header logo must never leave the Events site (#470). This checks the
 * brand-link anchor's `href` directly in source for every public page that
 * has one, rather than rendering each page (several need heavy session and
 * act-as mocking that would add nothing here).
 */
const pagesWithHeaderLogo = [
  "app/page.tsx",
  "app/(public)/clubs/page.tsx",
  "app/(public)/account/(portal)/layout.tsx",
  "app/(public)/account/events/[eventSlug]/page.tsx",
  "app/(public)/account/two-step/page.tsx",
  "app/(public)/calendar/page.tsx",
];

const brandLink = /<(?:a|Link)\s+className="public-registration-brand public-event-brand-link"\s+href="([^"]*)">/;

describe("public header logo links (#470)", () => {
  for (const file of pagesWithHeaderLogo) {
    it(`${file} keeps the header logo on the Events site`, () => {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      const match = source.match(brandLink);
      expect(match, `expected to find the brand-link anchor in ${file}`).toBeTruthy();
      expect(match?.[1]).toBe("/");
    });
  }
});
