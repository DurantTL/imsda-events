import { describe, expect, it } from "vitest";
import { RADIO_CARD_MAX_OPTIONS, isSingleChoiceType, suggestedSingleChoiceType } from "@/modules/forms/choice-defaults";

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
