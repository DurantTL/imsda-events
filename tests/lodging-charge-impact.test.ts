import { describe, expect, it } from "vitest";
import { lodgingChargeImpact, promoContextOf, type RegistrationPromo } from "@/modules/lodging/pricing";
import { storedPromoDiscount } from "@/modules/promo-codes/stored-discount";
import { buildReviewItems, chargeChangeSentence, type ReviewFacts } from "@/modules/lodging/preferences-domain";

/** Synthetic amounts only (#803): what a lodging change really costs a registration that holds a saved promo code. */

const percent = (basisPoints: number, extra: Partial<RegistrationPromo> = {}): RegistrationPromo => ({
  code: "HALFOFF", discountType: "PERCENT_BPS", discountValue: basisPoints, maximumDiscountCents: null, minimumSubtotalCents: null, coversLodging: true, sponsored: false, ...extra,
});
const fixed = (cents: number, extra: Partial<RegistrationPromo> = {}): RegistrationPromo => ({ ...percent(0), code: "FLAT", discountType: "FIXED_CENTS", discountValue: cents, ...extra });

describe("the stored code's discount", () => {
  it("is a percent with its cap, a fixed amount, never above the subtotal, and zero under the minimum", () => {
    const terms = { discountType: "PERCENT_BPS" as const, discountValue: 5000, maximumDiscountCents: 3000, minimumSubtotalCents: 2000 };
    expect(storedPromoDiscount(terms, 10_000)).toEqual({ belowMinimum: false, discountCents: 3000 });
    expect(storedPromoDiscount(terms, 4001)).toEqual({ belowMinimum: false, discountCents: 2000 });
    expect(storedPromoDiscount(terms, 1999)).toEqual({ belowMinimum: true, discountCents: 0 });
    expect(storedPromoDiscount({ ...terms, discountType: "FIXED_CENTS", discountValue: 9000, maximumDiscountCents: null }, 4000).discountCents).toBe(4000);
  });
});

describe("what a lodging change costs a registrant who holds a promo code", () => {
  it("is the list change with no code", () => {
    expect(lodgingChargeImpact({ otherCents: 5000, fromCents: 8000, toCents: 4000, promo: null })).toEqual({ listDeltaCents: -4000, registrantDeltaCents: -4000, discountDeltaCents: 0, promo: null });
  });

  it("percent code: a $80 line cut to $40 under a 50% code is -$20 for the registrant, not -$40", () => {
    const impact = lodgingChargeImpact({ otherCents: 0, fromCents: 8000, toCents: 4000, promo: percent(5000) });
    expect(impact.listDeltaCents).toBe(-4000);
    expect(impact.registrantDeltaCents).toBe(-2000);
    expect(impact.discountDeltaCents).toBe(-2000);
  });

  it("percent code on top of other lines is worked out on the whole subtotal, with the cap", () => {
    // 50% of 5000 + 8000 = 6500 before; of 5000 + 4000 = 4500 after: the registrant pays 6500 then 4500.
    expect(lodgingChargeImpact({ otherCents: 5000, fromCents: 8000, toCents: 4000, promo: percent(5000) }).registrantDeltaCents).toBe(-2000);
    // A cap of $30 means the discount is $30 both times: the registrant feels the whole list change.
    expect(lodgingChargeImpact({ otherCents: 5000, fromCents: 8000, toCents: 4000, promo: percent(5000, { maximumDiscountCents: 3000 }) }).registrantDeltaCents).toBe(-4000 + 0);
  });

  it("fixed code: the discount does not move until the subtotal drops below it", () => {
    expect(lodgingChargeImpact({ otherCents: 5000, fromCents: 8000, toCents: 4000, promo: fixed(3000) }).registrantDeltaCents).toBe(-4000);
    // $30 off a $50 other line plus a lodging line cut from $80 to $0: the subtotal 5000 still takes the whole $30.
    expect(lodgingChargeImpact({ otherCents: 0, fromCents: 2000, toCents: 1000, promo: fixed(3000) })).toMatchObject({ listDeltaCents: -1000, registrantDeltaCents: 0, discountDeltaCents: -1000 });
  });

  it("church-sponsored 100% code: the registrant owes nothing either way, and the sponsor carries the whole list change", () => {
    const impact = lodgingChargeImpact({ otherCents: 5000, fromCents: 8000, toCents: 4000, promo: percent(10_000, { sponsored: true, code: "CHURCH" }) });
    expect(impact.registrantDeltaCents).toBe(0);
    expect(impact.discountDeltaCents).toBe(-4000);
    expect(impact.promo).toEqual({ code: "CHURCH", coversLodging: true, sponsored: true });
    const sentence = chargeChangeSentence({ chargeDeltaCents: impact.listDeltaCents, registrantDeltaCents: impact.registrantDeltaCents, sponsorDeltaCents: impact.discountDeltaCents, promo: impact.promo });
    expect(sentence).toContain("-$40.00 at list price");
    expect(sentence).toContain("the registrant's change is +$0.00");
    expect(sentence).toContain("the sponsor's share is -$40.00");
    expect(sentence).toContain("Adjust Payments by the registrant figure");
  });

  it("an older registration, whose code never covered lodging, keeps the old math: the registrant feels the list change", () => {
    const impact = lodgingChargeImpact({ otherCents: 5000, fromCents: 8000, toCents: 4000, promo: percent(5000, { coversLodging: false }) });
    expect(impact).toMatchObject({ listDeltaCents: -4000, registrantDeltaCents: -4000, discountDeltaCents: 0 });
    expect(chargeChangeSentence({ chargeDeltaCents: -4000, registrantDeltaCents: -4000, promo: impact.promo })).toContain("does not apply to the lodging line");
  });

  it("sentences without a code are the plain list change", () => {
    expect(chargeChangeSentence({ chargeDeltaCents: 2000, promo: null })).toBe("This change alters the lodging charge (+$20.00), but the registration's total was not changed.");
  });
});

describe("a registration's pricing snapshot and saved code", () => {
  const snapshot = { lineItems: [{ key: "registration_fee", amountCents: 5000 }, { key: "lodging", amountCents: 8000 }, { key: "credit", amountCents: -500 }], promoCoversLodging: true };
  const redemption = { codeSnapshot: "HALFOFF", discountTypeSnapshot: "PERCENT_BPS" as const, discountValueSnapshot: 5000, maximumDiscountCentsSnapshot: null, minimumSubtotalCentsSnapshot: null, sponsored: true };

  it("takes the other lines' total and whether the code covers lodging from the snapshot", () => {
    expect(promoContextOf(snapshot, redemption)).toMatchObject({ otherCents: 4500, promo: { code: "HALFOFF", coversLodging: true, sponsored: true } });
    // A snapshot written before codes covered lodging carries no marker: the old math.
    expect(promoContextOf({ lineItems: snapshot.lineItems }, redemption).promo?.coversLodging).toBe(false);
    expect(promoContextOf(snapshot, null).promo).toBeNull();
    expect(promoContextOf(null, null)).toEqual({ otherCents: 0, promo: null });
  });
});

describe("the review queue shows the discounted figure beside the list one", () => {
  const nights = ["2027-06-15", "2027-06-16"];
  const registrations: ReviewFacts["registrations"] = new Map([["r1", { confirmationCode: "REG-1", label: "REG-1 (Alex Example)", active: true }]]);
  const facts = (overrides: Partial<ReviewFacts>): ReviewFacts => ({ nights, registrations, people: [], requests: [], roommates: [], rules: [], guardians: [], capacity: {}, ...overrides });

  it("on a requested change: the rooms and bedding asked for, the list change, and the change after the code", () => {
    const impact = { promoCode: "HALFOFF", coversLodging: true, sponsored: false, registrantDeltaCents: -2000, discountDeltaCents: -2000 };
    const [item] = buildReviewItems(facts({ changeRequests: [{ id: "c1", registrationId: "r1", category: "DORM_ROOM", chargedCents: 8000, requestedCents: 4000, partySize: 5, roomCount: 2, bringsExtraBedding: true, impact }] }));
    expect(item?.title).toContain("(list -$40.00)");
    expect(item?.title).toContain("5 people, 2 rooms, bringing sleeping bags or air mattresses");
    expect(item?.detail).toContain("After code HALFOFF the registrant's change is -$20.00");
    expect(item?.detail).toContain("Adjust Payments by that amount, not the list figure");
    const [plain] = buildReviewItems(facts({ changeRequests: [{ id: "c1", registrationId: "r1", category: "DORM_ROOM", chargedCents: 8000, requestedCents: 4000 }] }));
    expect(plain?.detail).not.toContain("After code");
    expect(plain?.fingerprint).not.toBe(item?.fingerprint);
  });

  it("on a charge that differs from the request", () => {
    const impact = { promoCode: "CHURCH", coversLodging: true, sponsored: true, registrantDeltaCents: 0, discountDeltaCents: 4000 };
    const items = buildReviewItems(facts({ lodgingCharges: [{ registrationId: "r1", chargedCents: 4000, currentCents: 8000, impact }] }));
    const price = items.find((entry) => entry.kind === "PRICE_DIFFERS");
    expect(price?.detail).toContain("After code CHURCH the registrant's change is +$0.00, and the sponsor's share +$40.00");
  });
});
