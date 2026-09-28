import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RefundReviewFacts, refundReasonError } from "@/components/refund-review-summary";

/**
 * The refund confirm dialog's body (#472): staff must see the amount,
 * reason, registration, and payment one more time before a refund is
 * recorded. This renders exactly what `FinanceWorkspace` passes to the
 * shared `ConfirmDialog`, without mounting the whole stateful workspace.
 */
describe("RefundReviewFacts (#472)", () => {
  it("repeats the amount, reason, registration, and payment", () => {
    const html = renderToStaticMarkup(createElement(RefundReviewFacts, {
      amountCents: 4_500,
      reason: "Duplicate registration submitted by mistake.",
      registrationLabel: "REG-ONE · Avery Johnson",
      paymentAmountCents: 20_000,
      paymentMethod: "CHECK",
    }));

    expect(html).toContain("$45.00");
    expect(html).toContain("Duplicate registration submitted by mistake.");
    expect(html).toContain("REG-ONE · Avery Johnson");
    expect(html).toContain("$200.00");
    expect(html).toContain("check");
  });

  it("labels a card-on-file payment as Square, not the raw enum", () => {
    const html = renderToStaticMarkup(createElement(RefundReviewFacts, {
      amountCents: 1_000,
      reason: "Attendee cancelled before the event.",
      registrationLabel: "REG-TWO · Jordan Lee",
      paymentAmountCents: 10_000,
      paymentMethod: "CARD_REFERENCE",
    }));

    expect(html).toContain("Square card");
    expect(html).not.toContain("CARD_REFERENCE");
  });
});

describe("refundReasonError (#472)", () => {
  it("rejects a reason that is too short once trimmed", () => {
    expect(refundReasonError("   ")).toMatch(/at least 3/);
    expect(refundReasonError("  ab  ")).toMatch(/at least 3/);
  });

  it("rejects a reason over 300 characters", () => {
    expect(refundReasonError("x".repeat(301))).toMatch(/300/);
  });

  it("accepts a trimmed reason within the limits", () => {
    expect(refundReasonError("  Duplicate card charge  ")).toBe("");
  });
});
