import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BirthDateField } from "@/components/birth-date-field";

describe("birth date field (#424)", () => {
  it("shows a saved date as typed text, and submits it as one hidden value", () => {
    const html = renderToStaticMarkup(createElement(BirthDateField, { name: "birthDate", label: "Birth date", defaultValue: "2014-03-09" }));
    expect(html).toContain('type="hidden" name="birthDate" value="2014-03-09"');
    expect(html).toMatch(/value="3\/9\/2014"/);
    expect(html).toContain("Reads as March 9, 2014.");
    // Typed, not a spinner or dropdowns.
    expect(html).not.toContain('type="date"');
    expect(html).not.toContain("<select");
  });

  it("starts empty, and submits nothing, until there's a value", () => {
    const html = renderToStaticMarkup(createElement(BirthDateField, { name: "birthDate", label: "Birth date" }));
    expect(html).toContain('type="hidden" name="birthDate" value=""');
    expect(html).toMatch(/value=""/);
    expect(html).toContain("Month/day/year");
  });

  it("marks the visible box required when asked, but never the hidden value", () => {
    const required = renderToStaticMarkup(createElement(BirthDateField, { name: "birthDate", label: "Birth date", required: true }));
    expect(required).toMatch(/<input[^>]*placeholder="M\/D\/YYYY"[^>]*required=""/);

    const optional = renderToStaticMarkup(createElement(BirthDateField, { name: "birthDate", label: "Birth date", required: false }));
    expect(optional).not.toMatch(/<input[^>]*placeholder="M\/D\/YYYY"[^>]*required=""/);
  });
});
