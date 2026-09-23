import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { CheckInPaymentDue } from "@/components/check-in-payment-due";
import { BROWSER_TRANSLATE_HELP_URL, TranslateHint } from "@/components/translate-hint";

/**
 * The site is English-first and relies on browser translation for Spanish.
 * Names, confirmation codes, and money shown on the key public, attendee, and
 * check-in screens must carry translate="no", or a translator can turn a name
 * into a word and freeze a value React later updates.
 */
const keyFiles = [
  "app/(public)/manage/[token]/page.tsx",
  "app/(public)/account/(portal)/page.tsx",
  "app/(public)/account/(portal)/registrations/page.tsx",
  "app/(public)/account/(portal)/clubs/[organizationId]/events/[eventId]/page.tsx",
  "app/(public)/account/events/[eventSlug]/page.tsx",
  "components/public-registration-form.tsx",
  "components/public-square-payment.tsx",
  "components/public-attendee-passes.tsx",
  "components/check-in-workspace.tsx",
  "components/check-in-scanner.tsx",
  "components/check-in-payment-due.tsx",
];

// A JSX element whose first content is money, a confirmation code, or a name.
const displayedValue = /<(strong|b|dd|span|small)(\s[^>]*)?>(−?\{(money|formatCents)\(|\{[\w.?]*(confirmationCode|attendee\.name|group\.name)\}|\{(arrival|attendee)\.firstName\})/g;

describe("translate markers on key screens", () => {
  for (const file of keyFiles) {
    it(`${file} marks names, codes, and money as translate="no"`, () => {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      const unmarked = [...source.matchAll(displayedValue)]
        .filter((match) => !/translate="no"/.test(match[2] ?? ""))
        .map((match) => match[0]);
      expect(unmarked).toEqual([]);
    });
  }

  it("keeps the check-in card amounts untranslated", () => {
    const html = renderToStaticMarkup(
      createElement(CheckInPaymentDue, { balanceCents: 17_500, confirmationCode: "TEST-1002", partySize: 3 }),
    );
    expect(html).toContain('<b translate="no">$179.83</b>');
    expect(html).toContain('<span translate="no">TEST-1002</span>');
    expect(html).toContain('<span translate="no">$175.00</span>');
  });
});

describe("browser translation tip", () => {
  it("offers Spanish before the page is translated and links to how-to steps", () => {
    const html = renderToStaticMarkup(createElement(TranslateHint));
    expect(html).toContain('lang="es"');
    expect(html).toContain("¿Necesita español?");
    expect(html).toContain(`href="${BROWSER_TRANSLATE_HELP_URL}"`);
    expect(html).toContain('rel="noreferrer"');
  });

  it("uses no third-party translation script", () => {
    const config = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
    expect(config).not.toMatch(/translate\.google|gtranslate/i);
  });
});
