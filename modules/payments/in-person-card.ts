/**
 * What check-in staff key into the Square app when an attendee pays a
 * remaining balance by card at the door.
 *
 * Square charges a different rate for a card presented in person than for the
 * online Web Payments form, so this deliberately does not reuse the event's
 * online `percentageBasisPoints`/`fixedFeeCents`. The in-person rate was
 * approved for WR26 check-in: 2.6% + 15¢, passed to the attendee.
 *
 * The gross-up is the same shape as `processingFeeForSubtotal` in
 * `modules/forms/definition.ts`: the total is chosen so that, after Square
 * takes its fee from the total, the event receives the full balance. Rounding
 * up to the next cent means the event is never short.
 *
 * Nothing here records or charges anything. Staff put the confirmation code in
 * the Square payment note, and finance attaches the resulting payment on
 * Payments → Unmatched Square payments, which reads codes from that note.
 */
export const SQUARE_IN_PERSON_CARD_RATE = {
  percentageBasisPoints: 260,
  fixedFeeCents: 15,
} as const;

export type InPersonCardQuote = {
  balanceCents: number;
  cardFeeCents: number;
  cardTotalCents: number;
};

export function inPersonCardQuote(
  balanceCents: number,
  rate: { percentageBasisPoints: number; fixedFeeCents: number } = SQUARE_IN_PERSON_CARD_RATE,
): InPersonCardQuote | null {
  if (!Number.isSafeInteger(balanceCents) || balanceCents <= 0) return null;
  // Whole-number operands keep the quotient exact enough that `ceil` never
  // rounds an exact cent up, which `x / (1 - 0.026)` can do.
  const cardTotalCents = Math.ceil(
    ((balanceCents + rate.fixedFeeCents) * 10_000)
      / (10_000 - rate.percentageBasisPoints),
  );
  return {
    balanceCents,
    cardFeeCents: cardTotalCents - balanceCents,
    cardTotalCents,
  };
}

export function formatCents(cents: number) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}
