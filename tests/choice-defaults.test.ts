import { describe, expect, it } from "vitest";
import { RADIO_CARD_MAX_OPTIONS, isSingleChoiceType, resolvedTypeForFieldTypeChange, suggestedSingleChoiceType } from "@/modules/forms/choice-defaults";

describe("choose controls by the size of the answer set (#484)", () => {
  it("suggests radio cards for a short list", () => {
    expect(suggestedSingleChoiceType(2)).toBe("RADIO");
    expect(suggestedSingleChoiceType(RADIO_CARD_MAX_OPTIONS)).toBe("RADIO");
  });

  it("suggests a searchable select once the list grows past the radio-card threshold", () => {
    expect(suggestedSingleChoiceType(RADIO_CARD_MAX_OPTIONS + 1)).toBe("SELECT");
    expect(suggestedSingleChoiceType(50)).toBe("SELECT");
  });

  it("only single-choice types (RADIO/SELECT) are covered by this default", () => {
    expect(isSingleChoiceType("RADIO")).toBe(true);
    expect(isSingleChoiceType("SELECT")).toBe(true);
    expect(isSingleChoiceType("MULTISELECT")).toBe(false);
    expect(isSingleChoiceType("RANKED_CHOICE")).toBe(false);
    expect(isSingleChoiceType("CHECKBOX")).toBe(false);
    expect(isSingleChoiceType("TEXT")).toBe(false);
  });
});

describe("the size default applies only when a field is created, never on a later edit (#484 B1)", () => {
  it("a brand-new choice field (switching from a non-choice type) gets the size default", () => {
    expect(resolvedTypeForFieldTypeChange("TEXT", "RADIO", 3)).toBe("RADIO");
    expect(resolvedTypeForFieldTypeChange("TEXT", "RADIO", 12)).toBe("SELECT");
    expect(resolvedTypeForFieldTypeChange("TEXT", "SELECT", 3)).toBe("RADIO");
    expect(resolvedTypeForFieldTypeChange("TEXT", "SELECT", 12)).toBe("SELECT");
  });

  it("switching a multi-select's many options straight to a single choice still gets the size default", () => {
    // MULTISELECT keeps its existing options when the dropdown moves to
    // RADIO/SELECT (registration-builder-workspace.tsx's own options-reset
    // rule), so a 12-option multi-select becoming "Single choice" is a
    // brand-new single-choice field with 12 options, not an edit to an
    // existing one.
    expect(resolvedTypeForFieldTypeChange("MULTISELECT", "RADIO", 12)).toBe("SELECT");
    expect(resolvedTypeForFieldTypeChange("MULTISELECT", "RADIO", 3)).toBe("RADIO");
  });

  it("an explicit RADIO with 12 options stays RADIO — the resolver never touches an already-single-choice field's type", () => {
    // This is what protects the options-edit handlers: even if the option
    // count changes (12, or any other number), the field's own type is
    // simply never passed through this function, and this function itself
    // refuses to override a field that was already RADIO or SELECT.
    expect(resolvedTypeForFieldTypeChange("RADIO", "RADIO", 12)).toBe("RADIO");
    expect(resolvedTypeForFieldTypeChange("RADIO", "RADIO", 2)).toBe("RADIO");
  });

  it("a template's 3-option SELECT stays SELECT when the field type is left unchanged", () => {
    expect(resolvedTypeForFieldTypeChange("SELECT", "SELECT", 3)).toBe("SELECT");
  });

  it("explicitly switching between RADIO and SELECT (the builder's own override) is always respected", () => {
    expect(resolvedTypeForFieldTypeChange("RADIO", "SELECT", 3)).toBe("SELECT");
    expect(resolvedTypeForFieldTypeChange("SELECT", "RADIO", 12)).toBe("RADIO");
  });

  it("a target type outside RADIO/SELECT is never touched", () => {
    expect(resolvedTypeForFieldTypeChange("RADIO", "MULTISELECT", 12)).toBe("MULTISELECT");
    expect(resolvedTypeForFieldTypeChange("TEXT", "CHECKBOX", 0)).toBe("CHECKBOX");
    expect(resolvedTypeForFieldTypeChange("TEXT", "NUMBER", 0)).toBe("NUMBER");
  });
});
