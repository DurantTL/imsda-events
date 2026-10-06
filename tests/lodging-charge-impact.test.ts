import { describe, expect, it, vi } from "vitest";

// The amendment's pricing step is a pure function; nothing here touches a database.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => { throw new Error("not used"); } }));
vi.mock("@/modules/registrations/repository", () => ({ getRegistrationByIdWithClient: vi.fn() }));
vi.mock("@/modules/communications/transactional-messages", () => ({ enqueueRegistrationUpdatedMessage: vi.fn() }));

import { registrationFormDefinitionSchema, type FormCalculation } from "@/modules/forms/definition";
import { priceAmendedRegistration } from "@/modules/registrations/amendments-repository";
import { lodgingChargeImpact, promoContextOf, type RegistrationPromo } from "@/modules/lodging/pricing";
import { storedPromoDiscount } from "@/modules/promo-codes/stored-discount";
import { CHURCH_SPONSOR_WARNING, buildReviewItems, chargeChangeSentence, churchSponsorNeedsReview, type ReviewFacts } from "@/modules/lodging/preferences-domain";

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
    expect(lodgingChargeImpact({ otherCents: 5000, fromCents: 8000, toCents: 4000, promo: null })).toEqual({ listDeltaCents: -4000, registrantDeltaCents: -4000, discountDeltaCents: 0, belowMinimumAfter: false, promo: null });
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
    // $30 off, capped at the subtotal: a lodging-only $20 line cut to $10 leaves the registrant at $0 both times.
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
    expect(sentence).not.toContain("Adjust Payments");
    expect(sentence).toContain(CHURCH_SPONSOR_WARNING);
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
    expect(promoContextOf(null, null)).toEqual({ otherCents: 0, lodgingCents: 0, promo: null });
    expect(promoContextOf(snapshot, redemption).lodgingCents).toBe(8000);
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
    expect(item?.detail).not.toContain("Adjust Payments by");
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

describe("interim church-sponsor guidance (#803): nothing here changes a church's bill", () => {
  it("warns, with the finance-office wording, only for a sponsored code whose share would move", () => {
    expect(CHURCH_SPONSOR_WARNING).toBe("This registration's church sponsorship does not change automatically. The church's bill still reflects the original lodging. Contact the finance office before adjusting.");
    expect(churchSponsorNeedsReview({ sponsored: true, discountDeltaCents: -2000 })).toBe(true);
    expect(churchSponsorNeedsReview({ sponsored: true, discountDeltaCents: 0 })).toBe(false);
    expect(churchSponsorNeedsReview({ sponsored: false, discountDeltaCents: -2000 })).toBe(false);
    const sponsored = chargeChangeSentence({ chargeDeltaCents: -4000, registrantDeltaCents: -2000, sponsorDeltaCents: -2000, promo: { code: "HALFOFF", coversLodging: true, sponsored: true } });
    expect(sponsored).toContain(CHURCH_SPONSOR_WARNING);
    expect(sponsored).toContain("-$20.00");
    expect(sponsored).not.toContain("Adjust Payments");
    expect(chargeChangeSentence({ chargeDeltaCents: -4000, registrantDeltaCents: -2000, sponsorDeltaCents: 0, promo: { code: "FLAT", coversLodging: true, sponsored: false } })).not.toContain(CHURCH_SPONSOR_WARNING);
  });

  it("flags the queue item CHURCH_SPONSOR_REVIEW, on a requested change and on a charge that differs, and not otherwise", () => {
    const nights = ["2027-06-15"];
    const registrations: ReviewFacts["registrations"] = new Map([["r1", { confirmationCode: "REG-1", label: "REG-1 (Alex Example)", active: true }]]);
    const facts = (overrides: Partial<ReviewFacts>): ReviewFacts => ({ nights, registrations, people: [], requests: [], roommates: [], rules: [], guardians: [], capacity: {}, ...overrides });
    const sponsored = { promoCode: "CHURCH", coversLodging: true, sponsored: true, registrantDeltaCents: 0, discountDeltaCents: 4000 };
    const [change] = buildReviewItems(facts({ changeRequests: [{ id: "c1", registrationId: "r1", category: "DORM_ROOM", chargedCents: 4000, requestedCents: 8000, impact: sponsored }] }));
    expect(change?.flags).toEqual(["CHURCH_SPONSOR_REVIEW"]);
    expect(change?.detail).toContain(CHURCH_SPONSOR_WARNING);
    expect(change?.detail).not.toContain("Adjust Payments by");
    const price = buildReviewItems(facts({ lodgingCharges: [{ registrationId: "r1", chargedCents: 4000, currentCents: 8000, impact: sponsored }] })).find((item) => item.kind === "PRICE_DIFFERS");
    expect(price?.flags).toEqual(["CHURCH_SPONSOR_REVIEW"]);
    const plain = buildReviewItems(facts({ lodgingCharges: [{ registrationId: "r1", chargedCents: 4000, currentCents: 8000, impact: { ...sponsored, sponsored: false } }] })).find((item) => item.kind === "PRICE_DIFFERS");
    expect(plain?.flags).toBeUndefined();
  });

  it("says when a change would put the registration under the code's minimum", () => {
    const impact = lodgingChargeImpact({ otherCents: 5000, fromCents: 4000, toCents: 0, promo: percent(1000, { minimumSubtotalCents: 8000 }) });
    expect(impact).toMatchObject({ belowMinimumAfter: true, discountDeltaCents: -900 });
    expect(lodgingChargeImpact({ otherCents: 5000, fromCents: 4000, toCents: 2500, promo: percent(1000, { minimumSubtotalCents: 8000 }) }).belowMinimumAfter).toBe(true);
    expect(lodgingChargeImpact({ otherCents: 5000, fromCents: 4000, toCents: 3000, promo: percent(1000, { minimumSubtotalCents: 7000 }) }).belowMinimumAfter).toBe(false);
    // Already under it before the change: nothing new to say.
    expect(lodgingChargeImpact({ otherCents: 1000, fromCents: 1000, toCents: 500, promo: percent(1000, { minimumSubtotalCents: 8000 }) }).belowMinimumAfter).toBe(false);
    expect(chargeChangeSentence({ chargeDeltaCents: -4000, registrantDeltaCents: -3100, sponsorDeltaCents: 0, belowMinimumAfter: true, promo: { code: "TENOFF", coversLodging: true, sponsored: false } })).toMatch(/under code TENOFF's minimum.*no longer apply/);
    const [item] = buildReviewItems({
      nights: ["2027-06-15"], registrations: new Map([["r1", { confirmationCode: "REG-1", label: "REG-1 (Alex Example)", active: true }]]), people: [], requests: [], roommates: [], rules: [], guardians: [], capacity: {},
      changeRequests: [{ id: "c1", registrationId: "r1", category: "TENT", chargedCents: 4000, requestedCents: 0, impact: { promoCode: "TENOFF", coversLodging: true, sponsored: false, registrantDeltaCents: -3100, discountDeltaCents: -900, belowMinimumAfter: true } }],
    });
    expect(item?.detail).toContain("under the code's minimum");
  });
});

describe("the screens' discount arithmetic equals the amendment's own (#803)", () => {
  const definition = registrationFormDefinitionSchema.parse({
    title: "Synthetic", description: "", confirmationMessage: "Received.",
    sections: [{ id: "sec_1", title: "Registration", description: "", isReviewStep: false, fields: [{ id: "fld_1", key: "first_name", label: "First name", helpText: "", type: "TEXT", scope: "REGISTRATION", required: false, options: [] }] }],
  });
  const formLines = (cents: number): FormCalculation => ({ subtotalCents: cents, processingFeeCents: 0, totalCents: cents, lineItems: cents > 0 ? [{ key: "registration_fee", label: "Registration fee", amountCents: cents }] : [] });
  const lodgingLine = (amountCents: number) => ({ key: "lodging", label: "Lodging: Dorm room", amountCents });
  const redemption = (promo: RegistrationPromo) => ({
    codeSnapshot: promo.code, discountTypeSnapshot: promo.discountType, discountValueSnapshot: promo.discountValue,
    maximumDiscountCentsSnapshot: promo.maximumDiscountCents, minimumSubtotalCentsSnapshot: promo.minimumSubtotalCents,
  }) as unknown as Parameters<typeof priceAmendedRegistration>[0]["redemption"];
  const priced = (promo: RegistrationPromo, otherCents: number, lodgingCents: number) => priceAmendedRegistration({
    definition, responses: {}, calculation: formLines(otherCents), storedLine: lodgingLine(lodgingCents), redemption: redemption(promo), coversLodging: promo.coversLodging,
  });

  const cases: Array<{ name: string; promo: RegistrationPromo; other: number; from: number; to: number }> = [
    { name: "a percent code with a cap", promo: percent(5000, { maximumDiscountCents: 3000 }), other: 5000, from: 8000, to: 4000 },
    { name: "a percent code under its cap", promo: percent(5000, { maximumDiscountCents: 90_000 }), other: 5000, from: 8000, to: 4000 },
    { name: "a fixed code above the subtotal", promo: fixed(99_000), other: 0, from: 2000, to: 1000 },
    { name: "a fixed code below the subtotal", promo: fixed(3000), other: 5000, from: 8000, to: 4000 },
    { name: "a code with a minimum, still met", promo: percent(1000, { minimumSubtotalCents: 4000 }), other: 5000, from: 4000, to: 2000 },
    { name: "a church-sponsored 100% code", promo: percent(10_000, { sponsored: true }), other: 5000, from: 8000, to: 4000 },
  ];
  for (const covers of [true, false]) {
    for (const item of cases) {
      it(`${item.name}, ${covers ? "with" : "without"} the marker: the registrant's change is the amendment's subtotal change`, () => {
        const promo = { ...item.promo, coversLodging: covers };
        const impact = lodgingChargeImpact({ otherCents: item.other, fromCents: item.from, toCents: item.to, promo });
        const before = priced(promo, item.other, item.from);
        const after = priced(promo, item.other, item.to);
        expect(impact.registrantDeltaCents).toBe(after.subtotalCents - before.subtotalCents);
        expect(impact.listDeltaCents).toBe(item.to - item.from);
        // The discount the amendment records moves by exactly the discount the screens report.
        expect(impact.discountDeltaCents).toBe(((after as { discountAmountCents?: number }).discountAmountCents ?? 0) - ((before as { discountAmountCents?: number }).discountAmountCents ?? 0));
      });
    }
  }

  it("a code with a minimum: the amendment refuses where the screens say the code would no longer apply", () => {
    for (const covers of [true, false]) {
      const promo = percent(1000, { minimumSubtotalCents: 8000, coversLodging: covers });
      // Covering lodging: 5000 + 4000 is over the minimum, 5000 + 0 is not. Not covering: 5000 alone is under it already.
      const impact = lodgingChargeImpact({ otherCents: covers ? 5000 : 9000, fromCents: 4000, toCents: 0, promo });
      if (covers) {
        expect(impact.belowMinimumAfter).toBe(true);
        expect(() => priced(promo, 5000, 0)).toThrow(/ineligible for its saved promo code/);
      } else {
        expect(impact.belowMinimumAfter).toBe(false);
        expect(priced(promo, 9000, 0).subtotalCents).toBe(9000 - 900);
      }
    }
  });

  it("a registration without the marker keeps the old math whether or not it holds a code, so an unrelated change never moves its total", () => {
    const withCredit = (): FormCalculation => ({ subtotalCents: 0, processingFeeCents: 0, totalCents: 0, lineItems: [{ key: "registration_fee", label: "Registration fee", amountCents: 5000 }, { key: "meal_credit", label: "Meal credit", amountCents: -5000 }] });
    const noCode = priceAmendedRegistration({ definition, responses: {}, calculation: withCredit(), storedLine: lodgingLine(4000), redemption: null, coversLodging: false });
    expect(noCode.subtotalCents).toBe(4000);
    expect(noCode.lineItems.map((line) => line.key)).toEqual(["registration_fee", "meal_credit", "lodging"]);
    expect(noCode.lineItems.find((line) => line.key === "meal_credit")?.amountCents).toBe(-5000);
    const withCode = priceAmendedRegistration({ definition, responses: {}, calculation: formLines(5000), storedLine: lodgingLine(4000), redemption: redemption(percent(5000, { coversLodging: false })), coversLodging: false });
    expect(withCode.subtotalCents).toBe(2500 + 4000);
    // No stored lodging line: the form's own calculation, with or without a code.
    expect(priceAmendedRegistration({ definition, responses: {}, calculation: formLines(5000), storedLine: null, redemption: null, coversLodging: false }).subtotalCents).toBe(5000);
    // A registration that records the marker puts the line among the lines first.
    expect(priceAmendedRegistration({ definition, responses: {}, calculation: formLines(5000), storedLine: lodgingLine(4000), redemption: redemption(percent(5000)), coversLodging: true }).subtotalCents).toBe(4500);
  });
});
