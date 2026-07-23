import { describe, expect, it } from "vitest";
import {
  isPromoCodeEditorDraftDirty,
  normalizePromoCodeEditorDraft,
  savedPromoCodeEditorDraft,
  type PromoCodeEditorRecord,
  type RawPromoCodeEditorDraft,
} from "@/modules/promo-codes/editor-draft";

const savedFixedPromo: PromoCodeEditorRecord = {
  code: "SAVE25",
  isActive: true,
  discountType: "FIXED_CENTS",
  discountValue: 2_500,
  startsOn: "2026-08-01",
  endsOn: null,
  minimumSubtotalCents: 10_000,
  maximumUses: 50,
  maximumDiscountCents: null,
};

const matchingFixedDraft: RawPromoCodeEditorDraft = {
  code: "  save25  ",
  isActive: true,
  discountType: "FIXED_CENTS",
  discountValue: "25.00",
  startsOn: "2026-08-01",
  endsOn: "",
  minimumSubtotal: "100.0",
  maximumUses: "50",
  maximumDiscount: "999.00",
};

function dirty(
  saved: PromoCodeEditorRecord | null,
  current: RawPromoCodeEditorDraft,
) {
  return isPromoCodeEditorDraftDirty(
    savedPromoCodeEditorDraft(saved),
    normalizePromoCodeEditorDraft(current),
  );
}

describe("promo-code editor draft comparison", () => {
  it("keeps a newly opened blank editor clean", () => {
    expect(dirty(null, {
      code: " ",
      isActive: true,
      discountType: "FIXED_CENTS",
      discountValue: "",
      startsOn: "",
      endsOn: "",
      minimumSubtotal: "",
      maximumUses: "",
      maximumDiscount: "",
    })).toBe(false);
  });

  it("compares the effective saved values instead of harmless formatting", () => {
    expect(dirty(savedFixedPromo, matchingFixedDraft)).toBe(false);
  });

  it.each([
    ["code", { code: "SAVE30" }],
    ["active state", { isActive: false }],
    ["discount type", { discountType: "PERCENT_BPS" }],
    ["discount amount", { discountValue: "24.99" }],
    ["start date", { startsOn: "2026-08-02" }],
    ["end date", { endsOn: "2026-08-31" }],
    ["minimum subtotal", { minimumSubtotal: "125" }],
    ["maximum uses", { maximumUses: "49" }],
  ] as const)("detects a meaningful %s change", (_label, override) => {
    expect(dirty(savedFixedPromo, {
      ...matchingFixedDraft,
      ...override,
    })).toBe(true);
  });

  it("compares the maximum discount only for percentage codes", () => {
    const savedPercentagePromo: PromoCodeEditorRecord = {
      ...savedFixedPromo,
      discountType: "PERCENT_BPS",
      discountValue: 2_500,
      maximumDiscountCents: 1_000,
    };
    const matchingPercentageDraft: RawPromoCodeEditorDraft = {
      ...matchingFixedDraft,
      discountType: "PERCENT_BPS",
      maximumDiscount: "10.00",
    };

    expect(dirty(savedPercentagePromo, matchingPercentageDraft)).toBe(false);
    expect(dirty(savedPercentagePromo, {
      ...matchingPercentageDraft,
      maximumDiscount: "9.99",
    })).toBe(true);
  });
});
