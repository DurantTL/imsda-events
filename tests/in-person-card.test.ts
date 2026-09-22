import { describe, expect, it } from "vitest";
import {
  SQUARE_IN_PERSON_CARD_RATE,
  formatCents,
  inPersonCardQuote,
} from "@/modules/payments/in-person-card";

describe("in-person card quote", () => {
  it("grosses a WR26 balance up by Square's in-person rate", () => {
    expect(SQUARE_IN_PERSON_CARD_RATE).toEqual({ percentageBasisPoints: 260, fixedFeeCents: 15 });
    expect(inPersonCardQuote(17_500)).toEqual({
      balanceCents: 17_500,
      cardFeeCents: 483,
      cardTotalCents: 17_983,
    });
  });

  it("leaves the event with at least the full balance after Square's fee", () => {
    for (const balanceCents of [1, 99, 1_000, 17_500, 35_000, 52_500, 123_456]) {
      const quote = inPersonCardQuote(balanceCents)!;
      const squareFee = Math.round(quote.cardTotalCents * 0.026) + 15;
      expect(quote.cardTotalCents - squareFee).toBeGreaterThanOrEqual(balanceCents);
      // Never more than one cent over what is needed.
      const oneLess = quote.cardTotalCents - 1;
      expect(oneLess - (oneLess * 0.026 + 15)).toBeLessThan(balanceCents);
    }
  });

  it("does not round an exact amount up by an extra cent", () => {
    // (x + 15) * 10000 / 9740 is a whole number when x + 15 is a multiple of 487.
    expect(inPersonCardQuote(487 * 20 - 15)?.cardTotalCents).toBe(10_000);
  });

  it("returns nothing when nothing is owed", () => {
    expect(inPersonCardQuote(0)).toBeNull();
    expect(inPersonCardQuote(-500)).toBeNull();
    expect(inPersonCardQuote(Number.NaN)).toBeNull();
  });

  it("formats dollars for staff", () => {
    expect(formatCents(17_983)).toBe("$179.83");
  });
});
