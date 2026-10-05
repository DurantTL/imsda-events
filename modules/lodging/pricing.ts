import {
  describeRate,
  lodgingCategoryLabels,
  quoteStay,
  rateForCategory,
  type LodgingCategory,
  type LodgingRate,
} from "@/modules/lodging/domain";

/**
 * The lodging charge as a line of the registration's priced total (#199). Pure and free of server-only imports so the
 * public form, the server and the tests price lodging the same way.
 *
 * - **No rate means no line**: a category without a rate (Camp Heritage club events, or any type staff have not
 *   priced) adds nothing. Nothing is seeded; staff enter every amount.
 * - The line has its own key, `lodging`, and no attendee, so it is a registration-level line that confirmations,
 *   receipts, the private page and the payments page already show next to the form's own lines.
 * - A registration-level promo code discounts the whole subtotal, so it applies to this line like any other priced
 *   line; a per-person promo code is limited to that person's own lines and never touches it.
 */

export const LODGING_LINE_KEY = "lodging";

export type LodgingPriceLine = { key: typeof LODGING_LINE_KEY; label: string; amountCents: number; pricingLabel: string };

export function isLodgingLine(line: { key: string }) {
  return line.key === LODGING_LINE_KEY;
}

export type LodgingChargeInput = {
  category: LodgingCategory | null;
  /** Nights slept. */
  nights: number;
  partySize: number;
  rates: Partial<Record<LodgingCategory, LodgingRate | null>>;
  /** Price the stay at the normal rate even below a rate's minimum nights (a staff exception). */
  ignoreMinimum?: boolean;
};

export type LodgingCharge =
  | { kind: "NONE" }
  | { kind: "BELOW_MINIMUM_NIGHTS"; minimumNights: number }
  | { kind: "CHARGE"; line: LodgingPriceLine };

export function lodgingCharge(input: LodgingChargeInput): LodgingCharge {
  if (!input.category || input.nights < 1 || input.partySize < 1) return { kind: "NONE" };
  const rate = rateForCategory(input.rates, input.category);
  if (!rate) return { kind: "NONE" };
  const rates: LodgingChargeInput["rates"] = input.ignoreMinimum ? { ...input.rates, [input.category]: { ...rate, minimumNights: null } } : input.rates;
  const quote = quoteStay({ rates, category: input.category, nights: input.nights, partySize: input.partySize });
  if (quote.kind === "BELOW_MINIMUM_NIGHTS") return { kind: "BELOW_MINIMUM_NIGHTS", minimumNights: quote.minimumNights };
  if (quote.kind !== "CHARGE" || quote.totalCents <= 0) return { kind: "NONE" };
  const perNight = rate.basis === "PER_UNIT_NIGHT" || rate.basis === "PER_PERSON_NIGHT";
  return {
    kind: "CHARGE",
    line: {
      key: LODGING_LINE_KEY,
      label: `Lodging: ${lodgingCategoryLabels[input.category]}`,
      amountCents: quote.totalCents,
      pricingLabel: `${describeRate({ ...rate, minimumNights: null })}${perNight ? `, ${input.nights} night${input.nights === 1 ? "" : "s"}` : ""}${rate.basis === "PER_PERSON_NIGHT" || rate.basis === "PER_PERSON_PER_EVENT" ? `, ${input.partySize} ${input.partySize === 1 ? "person" : "people"}` : ""}`,
    },
  };
}

/** The lodging line a stored pricing snapshot holds, if any. */
export function storedLodgingLine(lineItems: ReadonlyArray<{ key: string; amountCents: number }>) {
  return lineItems.find(isLodgingLine) ?? null;
}
