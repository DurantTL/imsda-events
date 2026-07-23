import { describe, expect, it } from "vitest";
import {
  paymentChoiceInputSchema,
  paymentChoiceQuoteForSelection,
  paymentChoiceRequestFingerprint,
  promotedWaitlistPaymentQuote,
} from "@/modules/payments/payment-choice-domain";

const definition = {
  title: "Promoted waitlist payment",
  description: "",
  confirmationMessage: "Received.",
  payment: {
    enabled: true,
    currency: "USD" as const,
    paymentMethodFieldKey: "payment_method",
    cardOptionValue: "Credit / debit card",
    percentageBasisPoints: 290,
    fixedFeeCents: 30,
    passFeeToRegistrant: true,
  },
  sections: [{
    id: "payment-section",
    title: "Payment",
    description: "",
    fields: [{
      id: "payment-method",
      key: "payment_method",
      label: "Payment method",
      helpText: "",
      type: "RADIO" as const,
      scope: "REGISTRATION" as const,
      required: true,
      options: ["Pay later", "Credit / debit card"],
    }],
  }],
};

describe("promoted waitlist payment-choice domain", () => {
  it("grosses up the preserved discounted subtotal exactly once for card", () => {
    const preserved = promotedWaitlistPaymentQuote(definition, {
      currency: "USD",
      preDiscountSubtotalCents: 10_000,
      discountAmountCents: 2_000,
      subtotalCents: 8_000,
      processingFeeCents: 0,
      totalCents: 8_000,
    });

    expect(preserved).toEqual({
      baseSubtotalCents: 8_000,
      cardProcessingFeeCents: 270,
      cardTotalCents: 8_270,
      payLaterTotalCents: 8_000,
    });
    expect(paymentChoiceQuoteForSelection(
      definition,
      preserved!.baseSubtotalCents,
      "CARD",
    )).toEqual({
      baseSubtotalCents: 8_000,
      processingFeeCents: 270,
      totalCents: 8_270,
    });
    expect(paymentChoiceQuoteForSelection(
      definition,
      preserved!.baseSubtotalCents,
      "PAY_LATER",
    )).toEqual({
      baseSubtotalCents: 8_000,
      processingFeeCents: 0,
      totalCents: 8_000,
    });
  });

  it("rejects malformed choices and fingerprints optimistic state", () => {
    const input = paymentChoiceInputSchema.parse({
      choice: "CARD",
      clientRequestId: "19af978c-b75a-4860-9df5-e9110dc2671e",
      expectedPriorOperationId: null,
    });
    const first = paymentChoiceRequestFingerprint(
      "registration-1",
      input,
    );
    const second = paymentChoiceRequestFingerprint(
      "registration-1",
      { ...input, expectedPriorOperationId:
        "04a18ff0-a05a-487a-9e1b-8bd7d01adb05" },
    );

    expect(first).toHaveLength(64);
    expect(second).not.toBe(first);
    expect(paymentChoiceInputSchema.safeParse({
      ...input,
      choice: "CHARGE_ME_AUTOMATICALLY",
    }).success).toBe(false);
  });

  it("uses the immutable historical definition without requiring it to remain published", () => {
    expect(promotedWaitlistPaymentQuote(definition, {
      currency: "USD",
      subtotalCents: 5_000,
    })).toMatchObject({
      baseSubtotalCents: 5_000,
      cardTotalCents: 5_181,
    });
  });
});
