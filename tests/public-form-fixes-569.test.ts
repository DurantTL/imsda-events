import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PublicEventSlugNotFound } from "@/components/public-event-slug-not-found";
import { defaultTypeForNewChoiceField } from "@/modules/forms/choice-defaults";
import {
  dateFieldBounds,
  dateFieldProblem,
  isBirthDateField,
  numberFieldBounds,
  registrationFormDefinitionSchema,
  validateTestResponses,
  type RegistrationFormField,
} from "@/modules/forms/definition";
import { readFileSync } from "node:fs";

const now = new Date("2026-09-29T12:00:00Z");
const dateField = { type: "DATE", key: "birth_date", label: "Birth date" } as const;

describe("FB-5 date bounds (#569)", () => {
  it("rejects years before 1900 for any date field", () => {
    expect(dateFieldProblem({ type: "DATE", key: "arrival", label: "Arrival" }, "1899-12-31", now)).toMatch(/before 1900/);
    expect(dateFieldProblem({ type: "DATE", key: "arrival", label: "Arrival" }, "1900-01-01", now)).toBeNull();
    expect(dateFieldProblem({ type: "DATE", key: "arrival", label: "Arrival" }, "2030-01-01", now)).toBeNull();
  });
  it("rejects future birthdates but allows today", () => {
    expect(isBirthDateField(dateField)).toBe(true);
    expect(dateFieldProblem(dateField, "2026-09-30", now)).toMatch(/future/);
    expect(dateFieldProblem(dateField, "2026-09-29", now)).toBeNull();
  });
  it("gives the input min and max", () => {
    expect(dateFieldBounds(dateField, now)).toEqual({ min: "1900-01-01", max: "2026-09-29" });
    expect(dateFieldBounds({ type: "DATE", key: "arrival", label: "Arrival" }, now).max).toBeUndefined();
  });
  it("is enforced by the shared server validation", () => {
    const definition = registrationFormDefinitionSchema.parse({
      title: "Date bounds check", description: "Synthetic form.", confirmationMessage: "Received.",
      sections: [{ id: "details", title: "Details", description: "", fields: [
        { id: "birth_field", key: "birth_date", label: "Birth date", type: "DATE", scope: "REGISTRATION", required: true, helpText: "", options: [] },
      ] }],
    });
    const issues = (value: string) => validateTestResponses(definition, { birth_date: value }).issues ?? [];
    expect(issues("1850-01-01").length).toBeGreaterThan(0);
    expect(issues("2999-01-01").length).toBeGreaterThan(0);
    expect(issues("2010-05-05")).toEqual([]);
  });
});

describe("FB-5 numeric min/max (#569)", () => {
  it("honors builder min/max on a non-age number and caps an unset maximum", () => {
    const field = { key: "tickets", ageBounds: { minimumAge: 2, maximumAge: null } } as Pick<RegistrationFormField, "key" | "ageBounds">;
    expect(numberFieldBounds(field)).toEqual({ minimumAge: 2, maximumAge: 100000 });
  });
  it("builder exposes minimum and maximum inputs", () => {
    const src = readFileSync("components/registration-builder-workspace.tsx", "utf8");
    expect(src).toContain("Minimum value for");
    expect(src).toContain("Maximum value for");
  });
});

describe("FB-9 new choice fields (#569)", () => {
  it("defaults a new short dropdown to radio cards, keeps long lists and existing choice fields", () => {
    expect(defaultTypeForNewChoiceField("TEXT", "SELECT", 2)).toBe("RADIO");
    expect(defaultTypeForNewChoiceField("TEXT", "SELECT", 6)).toBe("RADIO");
    expect(defaultTypeForNewChoiceField("TEXT", "SELECT", 7)).toBe("SELECT");
    expect(defaultTypeForNewChoiceField("RADIO", "SELECT", 3)).toBe("SELECT");
    expect(defaultTypeForNewChoiceField("TEXT", "MULTISELECT", 3)).toBe("MULTISELECT");
  });
});

describe("F-13 / F-18 public form markup (#569)", () => {
  const src = readFileSync("components/public-registration-form.tsx", "utf8");
  it("confirms attendee removal by name and lets Cancel keep answers", () => {
    expect(src).toContain("Remove ${pendingName} and their answers?");
    expect(src).toContain("onCancel={() => setPendingRemoveClientId(null)}");
    expect(src).not.toContain("window.confirm(\n          `Remove");
  });
  it("marks required checkboxes required and aria-required", () => {
    expect(src).toMatch(/type="checkbox"\s+required=\{field\.required && !excused\}\s+aria-required=\{field\.required && !excused\}/);
  });
});

describe("unknown event slug page (#569)", () => {
  it("names the slug and links to the public event list", () => {
    const html = renderToStaticMarkup(createElement(PublicEventSlugNotFound, { slug: "no-such-event" }));
    expect(html).toContain("Event not found");
    expect(html).toContain("no-such-event");
    expect(html).toContain("https://imsda.org/events/");
    expect(html).toContain("IMSDA");
  });
});
