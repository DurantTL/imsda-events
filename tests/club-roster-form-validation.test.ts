import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BirthDateField } from "@/components/birth-date-field";
import { rosterFormFieldOrder, validateRosterForm } from "@/modules/club-rosters/form-validation";

/** F-26 (#571): inline, accessible errors on the "Add to roster" form. Synthetic data only. */

const valid = { firstName: "Test", lastName: "Youth", birthDate: "2014-04-17", birthDateText: "4/17/2014", gender: "FEMALE", editing: false };

describe("validateRosterForm", () => {
  it("passes a complete form", () => {
    expect(validateRosterForm(valid)).toEqual({});
  });

  it("names each invalid field", () => {
    const errors = validateRosterForm({ ...valid, firstName: "  ", lastName: "", birthDate: "", birthDateText: "", gender: "" });
    expect(errors).toEqual({
      firstName: "First name is required.",
      lastName: "Last name is required.",
      birthDate: "Birth date is required.",
      gender: "Choose a gender.",
    });
    expect(rosterFormFieldOrder[0]).toBe("firstName");
  });

  it("tells a typed but unreadable birth date apart from a missing one", () => {
    expect(validateRosterForm({ ...valid, birthDate: "", birthDateText: "13/45/20" }).birthDate).toMatch(/Enter a date like/);
  });

  it("lets an edit leave the birth date blank to keep it, but not type a bad one", () => {
    expect(validateRosterForm({ ...valid, birthDate: "", birthDateText: "", editing: true })).toEqual({});
    expect(validateRosterForm({ ...valid, birthDate: "", birthDateText: "nope", editing: true }).birthDate).toBeTruthy();
  });
});

describe("BirthDateField inline error", () => {
  it("shows the error as an alert linked to the input and marks it invalid", () => {
    const html = renderToStaticMarkup(createElement(BirthDateField, { name: "birthDate", label: "Birth date", error: "Birth date is required." }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Birth date is required.");
    expect(html).toContain('id="birthDate-error"');
    expect(html).toContain('aria-describedby="birthDate-parsed birthDate-error"');
    expect(html).toContain('aria-invalid="true"');
  });

  it("shows no alert without an error", () => {
    const html = renderToStaticMarkup(createElement(BirthDateField, { name: "birthDate", label: "Birth date" }));
    expect(html).not.toContain('role="alert"');
  });
});
