import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchableSelect } from "@/components/searchable-select";
import {
  filterSearchableChoices,
  normalizeChoiceSearch,
} from "@/modules/forms/searchable-choice";

const churches = [
  { value: "des-moines", label: "Des Moines Spanish SDA Church" },
  { value: "st-louis", label: "St Louis Central SDA Church" },
  { value: "other", label: "Other" },
];

describe("searchable form choices", () => {
  it("matches every search term regardless of case or position", () => {
    expect(filterSearchableChoices(churches, "SPANISH des")).toEqual([
      churches[0],
    ]);
  });

  it("normalizes accents before comparing choices", () => {
    expect(normalizeChoiceSearch("Église")).toBe("eglise");
  });

  it("returns all choices for an empty search and none for no match", () => {
    expect(filterSearchableChoices(churches, "")).toEqual(churches);
    expect(filterSearchableChoices(churches, "Kansas")).toEqual([]);
  });

  it("renders an accessible required combobox before it is opened", () => {
    const markup = renderToStaticMarkup(createElement(SearchableSelect, {
      id: "church",
      value: "",
      options: churches,
      required: true,
      describedBy: "church_help",
      onChange: () => undefined,
    }));

    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-describedby="church_help"');
    expect(markup).toContain("required");
  });
});
