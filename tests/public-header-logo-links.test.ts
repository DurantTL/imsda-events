import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The header logo must never leave the Events site (#470). Rather than a
 * hard-coded list (which silently misses new pages), this discovers every
 * `app/**\/*.tsx` that renders the header brand link and checks the `href`
 * of each brand-link tag in source. Rendering each page would need heavy
 * session and act-as mocking that adds nothing here.
 */
const BRAND_CLASS = "public-registration-brand public-event-brand-link";
const appDir = join(process.cwd(), "app");

function listTsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listTsxFiles(path);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [path] : [];
  });
}

/** Each opening tag (possibly spanning lines) that carries the brand class. */
function brandLinkTags(source: string): string[] {
  const tags: string[] = [];
  const tagPattern = /<(?:a|Link)\b[^>]*>/g;
  for (const match of source.matchAll(tagPattern)) {
    if (match[0].includes(`className="${BRAND_CLASS}"`)) tags.push(match[0]);
  }
  return tags;
}

/** The raw `href` value: a string literal, or a `{...}` expression. */
function hrefOf(tag: string): string | undefined {
  const literal = tag.match(/\bhref="([^"]*)"/);
  if (literal) return literal[1];
  const expression = tag.match(/\bhref=\{([^}]*)\}/);
  return expression ? `{${expression[1]}}` : undefined;
}

const filesWithBrandLink = listTsxFiles(appDir)
  .filter((file) => readFileSync(file, "utf8").includes(BRAND_CLASS))
  .map((file) => relative(process.cwd(), file))
  .sort();

describe("public header logo links (#470)", () => {
  it("finds the header logo on the known public pages (discovery sanity check)", () => {
    for (const known of [
      "app/page.tsx",
      "app/not-found.tsx",
      "app/(public)/clubs/page.tsx",
      "app/(public)/calendar/page.tsx",
      "app/(public)/events/[eventSlug]/page.tsx",
      "app/(public)/manage/[token]/page.tsx",
    ]) {
      expect(filesWithBrandLink).toContain(known);
    }
  });

  for (const file of filesWithBrandLink) {
    it(`${file} keeps every header logo on the Events site`, () => {
      const tags = brandLinkTags(readFileSync(join(process.cwd(), file), "utf8"));
      expect(tags.length, `expected a brand-link <a>/<Link> tag in ${file}`).toBeGreaterThan(0);
      for (const tag of tags) {
        const href = hrefOf(tag);
        expect(href, `brand link in ${file} has no href`).toBeDefined();
        // No absolute or protocol-relative URL, literal or inside an expression.
        expect(href).not.toMatch(/https?:|^\/\/|["'`]\/\//i);
        // A literal must be an on-site path; a dynamic href is allowed as long
        // as it carries no absolute URL (checked above).
        if (!href!.startsWith("{")) expect(href!.startsWith("/")).toBe(true);
      }
    });
  }
});
