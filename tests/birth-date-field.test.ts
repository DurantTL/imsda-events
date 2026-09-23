import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BirthDateField } from "@/components/birth-date-field";

describe("birth date field (#383)", () => {
  it("splits a saved date into month, day, and a typed year, and submits it as one value", () => {
    const html = renderToStaticMarkup(createElement(BirthDateField, { name: "birthDate", label: "Birth date", defaultValue: "2014-03-09" }));
    expect(html).toContain('type="hidden" name="birthDate" value="2014-03-09"');
    expect(html).toMatch(/<option value="3" selected="">March<\/option>/);
    expect(html).toMatch(/<option value="9" selected="">9<\/option>/);
    expect(html).toContain('value="2014"');
    // The year is typed, not a spinner.
    expect(html).not.toContain('type="date"');
  });

  it("submits nothing until every part is filled", () => {
    const html = renderToStaticMarkup(createElement(BirthDateField, { name: "birthDate", label: "Birth date" }));
    expect(html).toContain('type="hidden" name="birthDate" value=""');
  });
});
