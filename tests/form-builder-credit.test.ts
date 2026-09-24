import { describe, expect, it } from "vitest";
import {
  creditPatchForKindChange,
  creditSummary,
  hasCredit,
  removeCreditPatch,
} from "@/modules/forms/credit-fields";
import {
  formFieldSchema,
  formTemplates,
  registrationFormDefinitionSchema,
  type RegistrationFormDefinition,
  type RegistrationFormField,
} from "@/modules/forms/definition";

const camporee = formTemplates.find((template) => template.key === "spring_camporee_export")!.definition;
const creditField = camporee.sections
  .flatMap((section) => section.fields)
  .find((field) => field.key === "meal_sponsorship_count")!;

/** What the builder saves: the edited field, serialized as JSON like the save request. */
function saved(field: RegistrationFormField) {
  return formFieldSchema.safeParse(JSON.parse(JSON.stringify(field)));
}

function savedDefinition(patch: Partial<RegistrationFormField>) {
  const definition: RegistrationFormDefinition = {
    ...camporee,
    sections: camporee.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) => field.key === creditField.key ? { ...field, ...patch } : field),
    })),
  };
  return registrationFormDefinitionSchema.safeParse(JSON.parse(JSON.stringify(definition)));
}

describe("form builder credit fields (#409)", () => {
  it("describes the template's credit read-only", () => {
    expect(hasCredit(creditField)).toBe(true);
    expect(creditSummary(creditField)).toBe("Credit: $5.00 per unit, capped at headcount");
    expect(creditSummary({ creditCentsPerUnit: -250 })).toBe("Credit: $2.50 per unit");
    expect(creditSummary({})).toBeNull();
  });

  it("removes the credit so a price can be set and the form still saves", () => {
    const removed = { ...creditField, ...removeCreditPatch() };
    expect(hasCredit(removed)).toBe(false);
    expect(saved({ ...removed, priceCents: 500 }).success).toBe(true);
    // Without removing it first, a price alongside a credit is rejected.
    expect(saved({ ...creditField, priceCents: 500 }).success).toBe(false);
  });

  it("clears the credit when the field's type or scope changes", () => {
    const retyped = { ...creditField, type: "TEXT" as const, ...creditPatchForKindChange(creditField, { type: "TEXT" }) };
    expect(hasCredit(retyped)).toBe(false);
    expect(saved(retyped).success).toBe(true);

    const rescoped = { ...creditField, scope: "ATTENDEE" as const, ...creditPatchForKindChange(creditField, { scope: "ATTENDEE" }) };
    expect(hasCredit(rescoped)).toBe(false);
    expect(rescoped.capUnitsAtAttendeeCount).toBeUndefined();
    expect(saved(rescoped).success).toBe(true);
  });

  it("keeps the credit for an edit that does not change its kind", () => {
    expect(creditPatchForKindChange(creditField, { type: "NUMBER", scope: "REGISTRATION" })).toEqual({});
    expect(creditPatchForKindChange({ ...creditField, creditCentsPerUnit: undefined }, { type: "TEXT" })).toEqual({});
    expect(savedDefinition({ label: "Renamed" }).success).toBe(true);
    expect(savedDefinition(removeCreditPatch()).success).toBe(true);
  });
});
