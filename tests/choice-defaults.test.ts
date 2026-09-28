import { describe, expect, it } from "vitest";
import { RADIO_CARD_MAX_OPTIONS, isSingleChoiceType, singleChoiceTypeHint, suggestedSingleChoiceType } from "@/modules/forms/choice-defaults";

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

describe("the size default is only a hint: the builder's pick always stands (#484)", () => {
  const options = (count: number) => Array.from({ length: count }, (_, index) => `Option ${index + 1}`);

  it("suggests radio cards on a dropdown with a short list, at and below the threshold", () => {
    for (const count of [2, 4, RADIO_CARD_MAX_OPTIONS]) {
      expect(singleChoiceTypeHint({ type: "SELECT", options: options(count) })).toEqual({
        suggestedType: "RADIO",
        message: "Short list: radio cards are easier to tap.",
        actionLabel: "Switch to radio cards",
      });
    }
  });

  it("stops suggesting radio cards on a dropdown once the list is past the threshold", () => {
    expect(singleChoiceTypeHint({ type: "SELECT", options: options(RADIO_CARD_MAX_OPTIONS + 1) })).toBeNull();
    expect(singleChoiceTypeHint({ type: "SELECT", options: options(50) })).toBeNull();
  });

  it("suggests a searchable dropdown on radio cards with a long list", () => {
    for (const count of [RADIO_CARD_MAX_OPTIONS + 1, 12, 50]) {
      const hint = singleChoiceTypeHint({ type: "RADIO", options: options(count) });
      expect(hint?.suggestedType).toBe("SELECT");
      expect(hint?.actionLabel).toBe("Switch to a searchable dropdown");
    }
  });

  it("shows nothing on radio cards with a short list", () => {
    expect(singleChoiceTypeHint({ type: "RADIO", options: options(2) })).toBeNull();
    expect(singleChoiceTypeHint({ type: "RADIO", options: options(RADIO_CARD_MAX_OPTIONS) })).toBeNull();
  });

  it("appears and disappears as the option count crosses the threshold", () => {
    expect(singleChoiceTypeHint({ type: "RADIO", options: options(RADIO_CARD_MAX_OPTIONS) })).toBeNull();
    expect(singleChoiceTypeHint({ type: "RADIO", options: options(RADIO_CARD_MAX_OPTIONS + 1) })).not.toBeNull();
    expect(singleChoiceTypeHint({ type: "SELECT", options: options(RADIO_CARD_MAX_OPTIONS + 1) })).toBeNull();
    expect(singleChoiceTypeHint({ type: "SELECT", options: options(RADIO_CARD_MAX_OPTIONS) })).not.toBeNull();
  });

  it("disappears once the builder takes the suggestion", () => {
    const hint = singleChoiceTypeHint({ type: "SELECT", options: options(3) })!;
    expect(singleChoiceTypeHint({ type: hint.suggestedType, options: options(3) })).toBeNull();
  });

  it("never applies to other field types or to attendee-type-sourced options", () => {
    for (const type of ["MULTISELECT", "RANKED_CHOICE", "CHECKBOX", "TEXT", "NUMBER"] as const) {
      expect(singleChoiceTypeHint({ type, options: options(3) })).toBeNull();
      expect(singleChoiceTypeHint({ type, options: options(12) })).toBeNull();
    }
    expect(singleChoiceTypeHint({ type: "RADIO", options: options(12), optionSource: "ATTENDEE_TYPES" })).toBeNull();
    expect(singleChoiceTypeHint({ type: "SELECT", options: options(3), optionSource: "ATTENDEE_TYPES" })).toBeNull();
  });

  it("no longer exports a helper that rewrites the Field type pick", async () => {
    const choiceDefaults: Record<string, unknown> = await import("@/modules/forms/choice-defaults");
    expect(choiceDefaults.resolvedTypeForFieldTypeChange).toBeUndefined();
  });
});
