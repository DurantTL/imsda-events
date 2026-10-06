/**
 * The discount a registration's saved (redeemed) promo code gives on a subtotal. Pure and free of imports so the amendment
 * engine and the lodging screens (which show what a lodging change really costs the registrant, #803) use one formula.
 */

export type StoredPromoTerms = {
  discountType: "FIXED_CENTS" | "PERCENT_BPS";
  discountValue: number;
  maximumDiscountCents: number | null;
  minimumSubtotalCents: number | null;
};

/** `belowMinimum` means the saved code would not apply to that subtotal (an amendment refuses it; the discount is then 0). */
export function storedPromoDiscount(terms: StoredPromoTerms, eligibleSubtotalCents: number): { belowMinimum: boolean; discountCents: number } {
  if (terms.minimumSubtotalCents !== null && eligibleSubtotalCents < terms.minimumSubtotalCents) return { belowMinimum: true, discountCents: 0 };
  const raw = terms.discountType === "FIXED_CENTS"
    ? terms.discountValue
    : Math.floor(eligibleSubtotalCents * terms.discountValue / 10_000);
  const capped = terms.discountType === "PERCENT_BPS" && terms.maximumDiscountCents !== null ? Math.min(raw, terms.maximumDiscountCents) : raw;
  return { belowMinimum: false, discountCents: Math.min(Math.max(0, eligibleSubtotalCents), Math.max(0, capped)) };
}
