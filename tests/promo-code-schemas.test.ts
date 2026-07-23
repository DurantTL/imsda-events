import { describe, expect, it } from "vitest";
import {
  promoCodeInputSchema,
  updatePromoCodeInputSchema,
} from "@/modules/promo-codes/schemas";

describe("promo-code inputs", () => {
  it("normalizes codes and nullable optional limits", () => {
    expect(promoCodeInputSchema.parse({
      code: "  retreat25 ",
      isActive: true,
      discountType: "FIXED_CENTS",
      discountValue: 2500,
      startsOn: "",
      endsOn: null,
      minimumSubtotalCents: null,
      maximumUses: 20,
      maximumDiscountCents: null,
    })).toMatchObject({
      code: "RETREAT25",
      startsOn: null,
      endsOn: null,
      maximumUses: 20,
    });
  });

  it("rejects impossible date, percentage, and cap combinations", () => {
    expect(promoCodeInputSchema.safeParse({
      code: "SALE",
      isActive: true,
      discountType: "PERCENT_BPS",
      discountValue: 10001,
      startsOn: "2026-09-02",
      endsOn: "2026-09-01",
      maximumDiscountCents: null,
    }).success).toBe(false);
    expect(promoCodeInputSchema.safeParse({
      code: "SALE",
      isActive: true,
      discountType: "FIXED_CENTS",
      discountValue: 500,
      maximumDiscountCents: 1000,
    }).success).toBe(false);
  });

  it("requires an optimistic-update timestamp on edits", () => {
    expect(updatePromoCodeInputSchema.safeParse({
      code: "SALE",
      isActive: false,
      discountType: "FIXED_CENTS",
      discountValue: 500,
      maximumDiscountCents: null,
    }).success).toBe(false);
  });
});

