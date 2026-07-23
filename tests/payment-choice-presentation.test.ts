import { describe, expect, it } from "vitest";
import {
  paymentChoiceOptionPresentations,
} from "@/modules/payments/payment-choice-presentation";

describe("promoted waitlist payment-choice presentation", () => {
  it("presents two plain-language options with the fee visible before selection", () => {
    const options = paymentChoiceOptionPresentations({
      available: true,
      locked: false,
      selected: null,
      currentOperationId: null,
      baseSubtotalCents: 8_000,
      cardProcessingFeeCents: 270,
      cardTotalCents: 8_270,
      payLaterTotalCents: 8_000,
    }, (cents) => `$${(cents / 100).toFixed(2)}`);

    expect(options).toEqual([{
      choice: "CARD",
      title: "Pay securely by card",
      detail: "Registration $80.00 + $2.70 card processing",
      totalCents: 8_270,
      selected: false,
    }, {
      choice: "PAY_LATER",
      title: "Pay later",
      detail: "No card processing fee is added.",
      totalCents: 8_000,
      selected: false,
    }]);
  });

  it("marks only the durable current choice as selected", () => {
    const options = paymentChoiceOptionPresentations({
      available: true,
      locked: false,
      selected: "PAY_LATER",
      currentOperationId:
        "04a18ff0-a05a-487a-9e1b-8bd7d01adb05",
      baseSubtotalCents: 8_000,
      cardProcessingFeeCents: 0,
      cardTotalCents: 8_000,
      payLaterTotalCents: 8_000,
    }, (cents) => `$${(cents / 100).toFixed(2)}`);

    expect(options.map(({ choice, selected }) => ({
      choice,
      selected,
    }))).toEqual([
      { choice: "CARD", selected: false },
      { choice: "PAY_LATER", selected: true },
    ]);
    expect(options[0]?.detail).toContain("no added processing fee");
  });
});
