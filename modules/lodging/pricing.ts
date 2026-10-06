import { storedPromoDiscount, type StoredPromoTerms } from "@/modules/promo-codes/stored-discount";
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
 *   line (#803); a per-person promo code is limited to that person's own lines and never touches it.
 * - A per-room rate is charged for the rooms the registrant chose (`roomCount`, #803). It is never derived from the
 *   party size. A site or a tent is one unit.
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
  /** Rooms (or sites) the registrant chose, charged under a per-room rate. Defaults to 1. */
  units?: number;
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
  const units = Math.max(1, input.units ?? 1);
  const quote = quoteStay({ rates, category: input.category, nights: input.nights, partySize: input.partySize, units });
  if (quote.kind === "BELOW_MINIMUM_NIGHTS") return { kind: "BELOW_MINIMUM_NIGHTS", minimumNights: quote.minimumNights };
  if (quote.kind !== "CHARGE" || quote.totalCents <= 0) return { kind: "NONE" };
  const perNight = rate.basis === "PER_UNIT_NIGHT" || rate.basis === "PER_PERSON_NIGHT";
  return {
    kind: "CHARGE",
    line: {
      key: LODGING_LINE_KEY,
      label: `Lodging: ${lodgingCategoryLabels[input.category]}${units > 1 && (rate.basis === "PER_UNIT_NIGHT" || rate.basis === "PER_UNIT_PER_EVENT") ? ` (${units} ${input.category === "RV_SITE" ? "sites" : "rooms"})` : ""}`,
      amountCents: quote.totalCents,
      pricingLabel: `${describeRate({ ...rate, minimumNights: null })}${perNight ? `, ${input.nights} night${input.nights === 1 ? "" : "s"}` : ""}${rate.basis === "PER_PERSON_NIGHT" || rate.basis === "PER_PERSON_PER_EVENT" ? `, ${input.partySize} ${input.partySize === 1 ? "person" : "people"}` : ""}`,
    },
  };
}

/** The lodging line a stored pricing snapshot holds, if any. */
export function storedLodgingLine(lineItems: ReadonlyArray<{ key: string; amountCents: number }>) {
  return lineItems.find(isLodgingLine) ?? null;
}

export type RegistrationPromo = StoredPromoTerms & {
  code: string;
  /** The code was decided on a subtotal that includes the lodging line (`promoCoversLodging` on the pricing snapshot, #803). */
  coversLodging: boolean;
  /** A church-sponsored code: the discount is the sponsor's share, the rest the registrant's. */
  sponsored: boolean;
};

/** The saved promo code of a registration, as the redemption row records it. */
export type RedemptionFact = {
  codeSnapshot: string;
  discountTypeSnapshot: "FIXED_CENTS" | "PERCENT_BPS";
  discountValueSnapshot: number;
  maximumDiscountCentsSnapshot: number | null;
  minimumSubtotalCentsSnapshot: number | null;
  sponsored: boolean;
};

/**
 * What a registration's current pricing snapshot and saved code say about a lodging change: the other lines' total, and
 * the code with whether it covers lodging (only a snapshot written when codes started covering lodging says so; an older
 * registration keeps the old math). A registration with no code has no promo.
 */
export function promoContextOf(snapshot: Record<string, unknown> | null, redemption: RedemptionFact | null): { otherCents: number; lodgingCents: number; promo: RegistrationPromo | null } {
  const lines = Array.isArray(snapshot?.lineItems) ? (snapshot!.lineItems as unknown[]) : [];
  let otherCents = 0;
  let lodgingCents = 0;
  for (const line of lines) {
    const row = line && typeof line === "object" ? line as Record<string, unknown> : {};
    if (typeof row.amountCents !== "number") continue;
    if (row.key === LODGING_LINE_KEY) lodgingCents += row.amountCents;
    else otherCents += row.amountCents;
  }
  if (!redemption) return { otherCents, lodgingCents, promo: null };
  return {
    otherCents,
    lodgingCents,
    promo: {
      code: redemption.codeSnapshot,
      discountType: redemption.discountTypeSnapshot,
      discountValue: redemption.discountValueSnapshot,
      maximumDiscountCents: redemption.maximumDiscountCentsSnapshot,
      minimumSubtotalCents: redemption.minimumSubtotalCentsSnapshot,
      coversLodging: snapshot?.promoCoversLodging === true,
      sponsored: redemption.sponsored,
    },
  };
}

export type LodgingChargeImpact = {
  /** The change in the lodging line at list price (what an unpromoted registration would see). */
  listDeltaCents: number;
  /** The change in what the registrant pays after the registration's saved promo code (the subtotal, before any card fee). */
  registrantDeltaCents: number;
  /** The change in the discount: for a church-sponsored code, the sponsor's share of the change. */
  discountDeltaCents: number;
  /** After the change the registration would be under the code's minimum: an amendment would refuse it, and the code would no longer apply. */
  belowMinimumAfter: boolean;
  promo: { code: string; coversLodging: boolean; sponsored: boolean } | null;
};

/**
 * What changing the lodging line from `fromCents` to `toCents` really does to a registration that holds a saved promo code
 * (#803). The code's discount is worked out the way an amendment would: on the other lines plus, when the registration's
 * code covers lodging, the lodging line, with the code's minimum and cap. A registration submitted before codes covered
 * lodging (`coversLodging` false) keeps the old math, so lodging is undiscounted and the registrant's change is the list change.
 */
export function lodgingChargeImpact(input: { otherCents: number; fromCents: number; toCents: number; promo: RegistrationPromo | null }): LodgingChargeImpact {
  const listDeltaCents = input.toCents - input.fromCents;
  if (!input.promo) return { listDeltaCents, registrantDeltaCents: listDeltaCents, discountDeltaCents: 0, belowMinimumAfter: false, promo: null };
  const { promo } = input;
  const discountOf = (lodgingCents: number) => storedPromoDiscount(promo, Math.max(0, input.otherCents + (promo.coversLodging ? lodgingCents : 0)));
  const discountDeltaCents = discountOf(input.toCents).discountCents - discountOf(input.fromCents).discountCents;
  return {
    listDeltaCents,
    registrantDeltaCents: listDeltaCents - discountDeltaCents,
    discountDeltaCents,
    belowMinimumAfter: discountOf(input.toCents).belowMinimum && !discountOf(input.fromCents).belowMinimum,
    promo: { code: promo.code, coversLodging: promo.coversLodging, sponsored: promo.sponsored },
  };
}
