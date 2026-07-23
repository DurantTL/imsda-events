import { describe, expect, it } from "vitest";
import {
  applyPromoCodeToCalculation,
  evaluatePromoCode,
  normalizePromoCode,
  type PromoCodeRule,
} from "@/modules/promo-codes/domain";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";

function rule(overrides: Partial<PromoCodeRule> = {}): PromoCodeRule {
  return {
    id: "promo_1",
    code: "RETREAT25",
    normalizedCode: "RETREAT25",
    isActive: true,
    discountType: "FIXED_CENTS",
    discountValue: 2_500,
    startsOn: null,
    endsOn: null,
    minimumSubtotalCents: null,
    maximumUses: null,
    maximumDiscountCents: null,
    redeemedCount: 0,
    ...overrides,
  };
}

const definition = registrationFormDefinitionSchema.parse({
  title: "Promo calculation",
  description: "",
  confirmationMessage: "Saved.",
  payment: {
    enabled: true,
    currency: "USD",
    paymentMethodFieldKey: "payment_method",
    cardOptionValue: "Card",
    percentageBasisPoints: 290,
    fixedFeeCents: 30,
    passFeeToRegistrant: true,
  },
  sections: [{
    id: "payment",
    title: "Payment",
    description: "",
    fields: [{
      id: "payment_method",
      key: "payment_method",
      label: "Payment",
      helpText: "",
      type: "RADIO",
      scope: "REGISTRATION",
      required: true,
      options: ["Card", "Pay later"],
    }],
  }],
});

describe("promo-code rules", () => {
  it("normalizes code case without making spaces or punctuation valid", () => {
    expect(normalizePromoCode("  retreat25  ")).toBe("RETREAT25");
    expect(evaluatePromoCode(rule(), {
      submittedCode: "retreat 25",
      eligibleSubtotalCents: 10_000,
      pricingDate: "2026-08-01",
    })).toMatchObject({
      valid: false,
      reason: "INVALID_FORMAT",
    });
  });

  it("treats start and end dates as inclusive event-calendar dates", () => {
    const dated = rule({
      startsOn: "2026-08-01",
      endsOn: "2026-08-31",
    });
    expect(evaluatePromoCode(dated, {
      submittedCode: "retreat25",
      eligibleSubtotalCents: 10_000,
      pricingDate: "2026-08-01",
    }).valid).toBe(true);
    expect(evaluatePromoCode(dated, {
      submittedCode: "RETREAT25",
      eligibleSubtotalCents: 10_000,
      pricingDate: "2026-08-31",
    }).valid).toBe(true);
    expect(evaluatePromoCode(dated, {
      submittedCode: "RETREAT25",
      eligibleSubtotalCents: 10_000,
      pricingDate: "2026-09-01",
    })).toMatchObject({ valid: false, reason: "ENDED" });
  });

  it("enforces active, minimum subtotal, and maximum-use rules", () => {
    expect(evaluatePromoCode(rule({ isActive: false }), {
      submittedCode: "RETREAT25",
      eligibleSubtotalCents: 10_000,
      pricingDate: "2026-08-01",
    })).toMatchObject({ valid: false, reason: "INACTIVE" });
    expect(evaluatePromoCode(rule({ minimumSubtotalCents: 15_000 }), {
      submittedCode: "RETREAT25",
      eligibleSubtotalCents: 10_000,
      pricingDate: "2026-08-01",
    })).toMatchObject({ valid: false, reason: "MINIMUM_NOT_MET" });
    expect(evaluatePromoCode(rule({
      maximumUses: 3,
      redeemedCount: 3,
    }), {
      submittedCode: "RETREAT25",
      eligibleSubtotalCents: 10_000,
      pricingDate: "2026-08-01",
    })).toMatchObject({ valid: false, reason: "USE_LIMIT_REACHED" });
  });

  it("floors percentage cents, applies its optional cap, and never makes the subtotal negative", () => {
    const percentage = evaluatePromoCode(rule({
      discountType: "PERCENT_BPS",
      discountValue: 3_333,
      maximumDiscountCents: 2_000,
    }), {
      submittedCode: "retreat25",
      eligibleSubtotalCents: 10_001,
      pricingDate: "2026-08-01",
    });
    expect(percentage).toMatchObject({
      valid: true,
      discountAmountCents: 2_000,
    });

    const fixed = evaluatePromoCode(rule({
      discountValue: 20_000,
    }), {
      submittedCode: "RETREAT25",
      eligibleSubtotalCents: 10_000,
      pricingDate: "2026-08-01",
    });
    expect(fixed).toMatchObject({
      valid: true,
      discountAmountCents: 10_000,
    });
  });

  it("recalculates the grossed-up card fee after discount", () => {
    const evaluation = evaluatePromoCode(rule(), {
      submittedCode: "RETREAT25",
      eligibleSubtotalCents: 10_000,
      pricingDate: "2026-08-01",
    });
    if (!evaluation.valid) throw new Error("Expected a valid fixture.");
    const discounted = applyPromoCodeToCalculation(
      definition,
      { payment_method: "Card" },
      {
        lineItems: [{
          key: "registration_fee",
          label: "Registration",
          amountCents: 10_000,
        }],
        subtotalCents: 10_000,
        processingFeeCents: 329,
        totalCents: 10_329,
      },
      evaluation,
    );
    expect(discounted).toMatchObject({
      preDiscountSubtotalCents: 10_000,
      discountAmountCents: 2_500,
      subtotalCents: 7_500,
      processingFeeCents: 255,
      totalCents: 7_755,
      promoCode: "RETREAT25",
    });
  });
});

