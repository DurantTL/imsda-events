import { describe, expect, it, vi } from "vitest";

// The amendment path is exercised through its pure promo step; nothing here touches a database.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => { throw new Error("not used"); } }));
vi.mock("@/modules/registrations/repository", () => ({ getRegistrationByIdWithClient: vi.fn() }));
vi.mock("@/modules/communications/transactional-messages", () => ({ enqueueRegistrationUpdatedMessage: vi.fn() }));
import { lodgingRateBases, quoteStay, rateSchema, type LodgingRate } from "@/modules/lodging/domain";
import { calculationWithLine, registrationFormDefinitionSchema, type FormCalculation } from "@/modules/forms/definition";
import { applyStoredPromo } from "@/modules/registrations/amendments-repository";
import { getPublicRegistrationStepPlan } from "@/modules/forms/public-registration-steps";
import { publicRegistrationInputSchema } from "@/modules/forms/public-domain";
import { applyAttendeePromoCodes, applyPromoCodeToCalculation, attendeeShareCents, evaluatePromoCode, type PromoCodeRule } from "@/modules/promo-codes/domain";
import { publicPromoCodeQuoteInputSchema } from "@/modules/promo-codes/schemas";
import {
  categoryIsFull,
  chosenNights,
  clampedRoomCount,
  defaultLodgingChoice,
  lodgingStepInput,
  lodgingStepLine,
  lodgingStepProblem,
  roomQuestion,
  type LodgingChoice,
  type LodgingStepOffer,
} from "@/modules/lodging/form-step";
import { LODGING_LINE_KEY, lodgingCharge } from "@/modules/lodging/pricing";
import { extraBeddingNote, partyExceedsBeds, resolveRoomChoice } from "@/modules/lodging/preferences-domain";

/** Synthetic rates and people only. */
const rate = (basis: LodgingRate["basis"], amountCents: number, minimumNights: number | null = null): LodgingRate => ({ amountCents, basis, minimumNights });

describe("every rate basis", () => {
  it("lists the per-night and the flat-for-the-event bases", () => {
    expect([...lodgingRateBases]).toEqual(["PER_UNIT_NIGHT", "PER_PERSON_NIGHT", "PER_UNIT_PER_EVENT", "PER_PERSON_PER_EVENT"]);
    for (const basis of lodgingRateBases) expect(rateSchema.safeParse({ category: "TENT", rate: { amountCents: 100, basis, minimumNights: null } }).success).toBe(true);
  });

  it("prices each basis", () => {
    const input = { category: "DORM_ROOM" as const, nights: 3, partySize: 2, units: 2 };
    expect(quoteStay({ ...input, rates: { DORM_ROOM: rate("PER_UNIT_NIGHT", 2500) } })).toMatchObject({ kind: "CHARGE", totalCents: 2500 * 3 * 2 });
    expect(quoteStay({ ...input, rates: { DORM_ROOM: rate("PER_PERSON_NIGHT", 500) } })).toMatchObject({ kind: "CHARGE", totalCents: 500 * 3 * 2 });
    expect(quoteStay({ ...input, rates: { DORM_ROOM: rate("PER_UNIT_PER_EVENT", 10_000) } })).toMatchObject({ kind: "CHARGE", totalCents: 10_000 * 2 });
    expect(quoteStay({ ...input, rates: { DORM_ROOM: rate("PER_PERSON_PER_EVENT", 4000) } })).toMatchObject({ kind: "CHARGE", totalCents: 4000 * 2 });
  });

  it("does not grow a flat rate with the nights, and still honors a minimum", () => {
    const flat = { DORM_ROOM: rate("PER_UNIT_PER_EVENT", 9000, 2) };
    expect(quoteStay({ rates: flat, category: "DORM_ROOM", nights: 2, partySize: 1 }).totalCents).toBe(9000);
    expect(quoteStay({ rates: flat, category: "DORM_ROOM", nights: 6, partySize: 1 }).totalCents).toBe(9000);
    expect(quoteStay({ rates: flat, category: "DORM_ROOM", nights: 1, partySize: 1 })).toMatchObject({ kind: "BELOW_MINIMUM_NIGHTS" });
  });

  it("charges nothing where there is no rate", () => {
    expect(quoteStay({ rates: {}, category: "RV_SITE", nights: 4, partySize: 3 })).toEqual({ kind: "INCLUDED", totalCents: 0 });
  });
});

describe("the lodging line", () => {
  it("has its own key and a label naming the type, and no attendee", () => {
    const charge = lodgingCharge({ category: "DORM_ROOM", nights: 3, partySize: 2, rates: { DORM_ROOM: rate("PER_UNIT_NIGHT", 2500) } });
    expect(charge.kind).toBe("CHARGE");
    if (charge.kind !== "CHARGE") return;
    expect(charge.line).toMatchObject({ key: LODGING_LINE_KEY, label: "Lodging: Dorm room", amountCents: 7500 });
    expect(charge.line).not.toHaveProperty("attendeeIndex");
    expect(charge.line.pricingLabel).toContain("3 nights");
  });

  it("says how many people a per-person rate counted, and not the nights of a flat one", () => {
    const flat = lodgingCharge({ category: "TENT", nights: 4, partySize: 3, rates: { TENT: rate("PER_PERSON_PER_EVENT", 4000) } });
    expect(flat.kind === "CHARGE" && flat.line.pricingLabel).toContain("3 people");
    expect(flat.kind === "CHARGE" && flat.line.pricingLabel).not.toContain("night");
  });

  it("adds nothing without a rate, a type or a stay", () => {
    expect(lodgingCharge({ category: "RV_SITE", nights: 3, partySize: 2, rates: {} })).toEqual({ kind: "NONE" });
    expect(lodgingCharge({ category: null, nights: 3, partySize: 2, rates: { TENT: rate("PER_UNIT_NIGHT", 100) } })).toEqual({ kind: "NONE" });
    expect(lodgingCharge({ category: "TENT", nights: 0, partySize: 2, rates: { TENT: rate("PER_UNIT_NIGHT", 100) } })).toEqual({ kind: "NONE" });
    expect(lodgingCharge({ category: "TENT", nights: 3, partySize: 2, rates: { TENT: rate("PER_UNIT_NIGHT", 0) } })).toEqual({ kind: "NONE" });
  });

  it("reports a stay under a minimum, unless a staff exception ignores it", () => {
    const rates = { DORM_ROOM: rate("PER_UNIT_NIGHT", 2000, 4) };
    expect(lodgingCharge({ category: "DORM_ROOM", nights: 2, partySize: 1, rates })).toEqual({ kind: "BELOW_MINIMUM_NIGHTS", minimumNights: 4 });
    const exception = lodgingCharge({ category: "DORM_ROOM", nights: 2, partySize: 1, rates, ignoreMinimum: true });
    expect(exception.kind === "CHARGE" && exception.line.amountCents).toBe(4000);
  });

  it("falls back from a tent with power to the tent rate", () => {
    const charge = lodgingCharge({ category: "TENT_WITH_POWER", nights: 2, partySize: 2, rates: { TENT: rate("PER_PERSON_NIGHT", 500) } });
    expect(charge.kind === "CHARGE" && charge.line.amountCents).toBe(2000);
  });
});

const formDefinition = registrationFormDefinitionSchema.parse({
  title: "Synthetic",
  description: "",
  confirmationMessage: "Received.",
  payment: { enabled: true, currency: "USD", paymentMethodFieldKey: "payment_method", cardOptionValue: "Card", passFeeToRegistrant: true, percentageBasisPoints: 290, fixedFeeCents: 30 },
  sections: [{
    id: "sec_1", title: "Registration", description: "", isReviewStep: false, fields: [
      { id: "fld_1", key: "first_name", label: "First name", helpText: "", type: "TEXT", scope: "REGISTRATION", required: false, options: [] },
      { id: "fld_2", key: "registration_fee", label: "Registration fee", helpText: "", type: "CHECKBOX", scope: "REGISTRATION", required: false, options: [], priceCents: 5000 },
      { id: "fld_3", key: "payment_method", label: "Payment method", helpText: "", type: "RADIO", scope: "REGISTRATION", required: false, options: ["Card", "Check"] },
    ],
  }],
});
const formCalculation = (): FormCalculation => ({ subtotalCents: 5000, processingFeeCents: 0, totalCents: 5000, lineItems: [{ key: "registration_fee", label: "Registration fee", amountCents: 5000 }] });

describe("the lodging line in the registration total", () => {
  const line = { key: LODGING_LINE_KEY, label: "Lodging: Dorm room", amountCents: 7500 };

  it("joins the subtotal as its own line and the fee follows it", () => {
    const card = { payment_method: "Card" };
    const withLodging = calculationWithLine(formDefinition, card, formCalculation(), line.key, line);
    expect(withLodging.lineItems.map((item) => item.key)).toEqual(["registration_fee", "lodging"]);
    expect(withLodging.subtotalCents).toBe(12_500);
    expect(withLodging.processingFeeCents).toBeGreaterThan(0);
    expect(withLodging.totalCents).toBe(withLodging.subtotalCents + withLodging.processingFeeCents);
    // Paying another way carries no card fee.
    expect(calculationWithLine(formDefinition, { payment_method: "Check" }, formCalculation(), line.key, line).processingFeeCents).toBe(0);
  });

  it("replaces the same line, and removes it with null", () => {
    const first = calculationWithLine(formDefinition, {}, formCalculation(), line.key, line);
    const second = calculationWithLine(formDefinition, {}, first, line.key, { ...line, amountCents: 2000 });
    expect(second.lineItems.filter((item) => item.key === "lodging")).toHaveLength(1);
    expect(second.subtotalCents).toBe(7000);
    expect(calculationWithLine(formDefinition, {}, second, line.key, null)).toMatchObject({ subtotalCents: 5000, lineItems: [{ key: "registration_fee" }] });
  });

  // Promo codes discount the lodging line (#803): the line joins the registration's lines first, then the code is decided.
  const promo = (overrides: Partial<Record<string, unknown>> = {}) => ({
    isActive: true, normalizedCode: "TENOFF", discountType: "PERCENT_BPS", discountValue: 1000, maximumDiscountCents: null,
    minimumSubtotalCents: null, startsAt: null, endsAt: null, maximumUses: null, redeemedCount: 0, ...overrides,
  }) as unknown as PromoCodeRule;
  const evaluate = (rule: PromoCodeRule, subtotalCents: number) => {
    const evaluation = evaluatePromoCode(rule, { submittedCode: "tenoff", eligibleSubtotalCents: subtotalCents, pricingDate: "2027-05-20", hideAmounts: false });
    if (!evaluation.valid) throw new Error(`expected a valid code: ${evaluation.reason}`);
    return evaluation;
  };
  const withLodging = (responses: Record<string, unknown> = {}) => calculationWithLine(formDefinition, responses, formCalculation(), line.key, line);

  it("is discounted by a registration-level percent code, and the discount is worked out on the subtotal including it", () => {
    const calculation = withLodging();
    const discounted = applyPromoCodeToCalculation(formDefinition, {}, calculation, evaluate(promo(), calculation.subtotalCents));
    expect(discounted.preDiscountSubtotalCents).toBe(5000 + 7500);
    expect(discounted.discountAmountCents).toBe(1250);
    expect(discounted.subtotalCents).toBe(12_500 - 1250);
    expect(discounted.totalCents).toBe(11_250);
    expect(discounted.lineItems.map((item) => item.key)).toEqual(["registration_fee", "lodging"]);
  });

  it("is discounted by a registration-level fixed code, never below zero", () => {
    const calculation = withLodging();
    const fixed = applyPromoCodeToCalculation(formDefinition, {}, calculation, evaluate(promo({ discountType: "FIXED_CENTS", discountValue: 3000 }), calculation.subtotalCents));
    expect(fixed.discountAmountCents).toBe(3000);
    expect(fixed.totalCents).toBe(9500);
    const huge = applyPromoCodeToCalculation(formDefinition, {}, calculation, evaluate(promo({ discountType: "FIXED_CENTS", discountValue: 99_000 }), calculation.subtotalCents));
    expect(huge.discountAmountCents).toBe(12_500);
    expect(huge.totalCents).toBe(0);
  });

  it("checks a code's minimum against the subtotal including lodging", () => {
    const rule = promo({ minimumSubtotalCents: 10_000 });
    expect(evaluatePromoCode(rule, { submittedCode: "tenoff", eligibleSubtotalCents: formCalculation().subtotalCents, pricingDate: "2027-05-20", hideAmounts: false }).valid).toBe(false);
    expect(evaluatePromoCode(rule, { submittedCode: "tenoff", eligibleSubtotalCents: withLodging().subtotalCents, pricingDate: "2027-05-20", hideAmounts: false }).valid).toBe(true);
  });

  it("makes the processing fee follow the final, discounted subtotal", () => {
    const card = { payment_method: "Card" };
    const calculation = withLodging(card);
    const discounted = applyPromoCodeToCalculation(formDefinition, card, calculation, evaluate(promo(), calculation.subtotalCents));
    // Fee on 11,250 (the discounted subtotal), not on 12,500.
    expect(discounted.processingFeeCents).toBe(Math.ceil((11_250 + 30) / (1 - 0.029)) - 11_250);
    expect(discounted.processingFeeCents).toBeLessThan(calculation.processingFeeCents);
    expect(discounted.totalCents).toBe(discounted.subtotalCents + discounted.processingFeeCents);
  });

  it("a church-sponsored code (a full sponsorship) covers the lodging line too, and the fee follows the zero subtotal", () => {
    const card = { payment_method: "Card" };
    const calculation = withLodging(card);
    const sponsored = applyPromoCodeToCalculation(formDefinition, card, calculation, evaluate(promo({ discountType: "PERCENT_BPS", discountValue: 10_000 }), calculation.subtotalCents));
    expect(sponsored.discountAmountCents).toBe(12_500);
    expect(sponsored.subtotalCents).toBe(0);
    expect(sponsored.processingFeeCents).toBe(0);
    expect(sponsored.totalCents).toBe(0);
    // The line itself stays in the snapshot: staff can see what the church covered.
    expect(sponsored.lineItems.find((item) => item.key === "lodging")?.amountCents).toBe(7500);
  });

  it("quote, submission and amendment agree: the same lines in, the same discount and total out", () => {
    const card = { payment_method: "Card" };
    const redemption = {
      codeSnapshot: "TENOFF", discountTypeSnapshot: "PERCENT_BPS", discountValueSnapshot: 1000, minimumSubtotalCentsSnapshot: 10_000, maximumDiscountCentsSnapshot: null,
    } as unknown as Parameters<typeof applyStoredPromo>[3];
    // Quote and submission: the lodging line joins first, then the code is evaluated on that subtotal.
    const quoteLines = withLodging(card);
    const quote = applyPromoCodeToCalculation(formDefinition, card, quoteLines, evaluate(promo({ minimumSubtotalCents: 10_000 }), quoteLines.subtotalCents));
    const submission = applyPromoCodeToCalculation(formDefinition, card, withLodging(card), evaluate(promo({ minimumSubtotalCents: 10_000 }), withLodging(card).subtotalCents));
    // Amendment: the stored lodging line is carried into the new calculation, then the stored code is applied.
    const amended = applyStoredPromo(formDefinition, card, calculationWithLine(formDefinition, card, formCalculation(), line.key, line), redemption);
    for (const priced of [submission, amended]) {
      expect(priced).toMatchObject({ preDiscountSubtotalCents: quote.preDiscountSubtotalCents, discountAmountCents: quote.discountAmountCents, subtotalCents: quote.subtotalCents, processingFeeCents: quote.processingFeeCents, totalCents: quote.totalCents });
      expect(priced.lineItems).toEqual(quote.lineItems);
    }
    // An amendment that drops the form's own fee below the code's minimum still counts the lodging in the subtotal it checks.
    const feeRemoved: FormCalculation = { subtotalCents: 0, processingFeeCents: 0, totalCents: 0, lineItems: [] };
    expect(applyStoredPromo(formDefinition, card, calculationWithLine(formDefinition, card, feeRemoved, line.key, { ...line, amountCents: 10_000 }), redemption)).toMatchObject({ discountAmountCents: 1000 });
  });

  it("keeps a per-person code on its own person's lines: the lodging line has no attendee", () => {
    const calculation: FormCalculation = calculationWithLine(formDefinition, {}, {
      subtotalCents: 3000, processingFeeCents: 0, totalCents: 3000,
      lineItems: [{ key: "meal", label: "Meal", amountCents: 1000, attendeeIndex: 0 }, { key: "meal", label: "Meal", amountCents: 2000, attendeeIndex: 1 }],
    }, line.key, line);
    expect(attendeeShareCents(calculation, 0)).toBe(1000);
    expect(attendeeShareCents(calculation, 1)).toBe(2000);
    const discounted = applyAttendeePromoCodes(formDefinition, {}, calculation, [{ attendeeIndex: 0, code: "KID", discountAmountCents: 400 }]);
    // Only the person's own 400 comes off; the 7,500 lodging line is untouched.
    expect(discounted.discountAmountCents).toBe(400);
    expect(discounted.subtotalCents).toBe(3000 + 7500 - 400);
    expect(discounted.lineItems.find((item) => item.key === "lodging")?.amountCents).toBe(7500);
  });

  it("has no attendee, so a per-person code never reaches it", () => {
    const withLodging = calculationWithLine(formDefinition, {}, formCalculation(), line.key, line);
    const roster: FormCalculation = { ...withLodging, lineItems: [{ key: "meal", label: "Meal", amountCents: 1000, attendeeIndex: 0 }, ...withLodging.lineItems] };
    expect(attendeeShareCents(roster, 0)).toBe(1000);
  });
});

describe("charging by the rooms the registrant chose (#803)", () => {
  it("charges a per-room rate for the chosen rooms, whatever the party size, and says how many in the label", () => {
    const rates = { DORM_ROOM: rate("PER_UNIT_NIGHT", 2000) };
    const oneRoomForSix = lodgingCharge({ category: "DORM_ROOM", nights: 2, partySize: 6, rates, units: 1 });
    expect(oneRoomForSix.kind === "CHARGE" && oneRoomForSix.line).toMatchObject({ amountCents: 4000, label: "Lodging: Dorm room" });
    const three = lodgingCharge({ category: "DORM_ROOM", nights: 2, partySize: 6, rates, units: 3 });
    expect(three.kind === "CHARGE" && three.line).toMatchObject({ amountCents: 12_000, label: "Lodging: Dorm room (3 rooms)" });
    const flat = lodgingCharge({ category: "DORM_ROOM", nights: 2, partySize: 6, rates: { DORM_ROOM: rate("PER_UNIT_PER_EVENT", 3000) }, units: 2 });
    expect(flat.kind === "CHARGE" && flat.line.amountCents).toBe(6000);
  });

  it("does not multiply a per-person rate by rooms", () => {
    const person = lodgingCharge({ category: "DORM_ROOM", nights: 2, partySize: 6, rates: { DORM_ROOM: rate("PER_PERSON_NIGHT", 1000) }, units: 3 });
    expect(person.kind === "CHARGE" && person.line.amountCents).toBe(12_000);
  });

  it("keeps an RV site or a tent at one unit in the form's line", () => {
    const rvOffer: LodgingStepOffer = { ...offer, categories: [{ category: "RV_SITE", label: "RV site", remaining: Object.fromEntries(offer.nights.map((night) => [night, 3])), rate: rate("PER_UNIT_NIGHT", 3000), unitCapacity: null, roomBased: false }] };
    const line = lodgingStepLine(rvOffer, { ...defaultLodgingChoice(rvOffer, 4), category: "RV_SITE", roomCount: 3 });
    expect(line).toMatchObject({ amountCents: 3000 * 4, label: "Lodging: RV site" });
  });
});

describe("the room count rules (#803)", () => {
  const rooms = { roomBased: true, unitCapacity: 2 };

  it("is one unit for a site, a tent or a counted area: nothing is asked", () => {
    expect(resolveRoomChoice({ capacity: { roomBased: false, unitCapacity: null }, partySize: 5, roomCount: 4, requireAcknowledgement: true })).toEqual({ ok: true, roomCount: 1, bringsExtraBedding: false, extraBeddingNeeded: false });
    expect(resolveRoomChoice({ capacity: undefined, partySize: 5, requireAcknowledgement: true })).toMatchObject({ ok: true, roomCount: 1 });
  });

  it("defaults to one room and allows one up to the party size", () => {
    expect(resolveRoomChoice({ capacity: rooms, partySize: 2, requireAcknowledgement: true })).toMatchObject({ ok: true, roomCount: 1 });
    expect(resolveRoomChoice({ capacity: rooms, partySize: 4, roomCount: 4, requireAcknowledgement: true })).toMatchObject({ ok: true, roomCount: 4, extraBeddingNeeded: false });
    expect(resolveRoomChoice({ capacity: rooms, partySize: 4, roomCount: 5, requireAcknowledgement: true })).toMatchObject({ ok: false, code: "ROOM_COUNT_INVALID" });
    expect(resolveRoomChoice({ capacity: rooms, partySize: 4, roomCount: 0, requireAcknowledgement: true })).toMatchObject({ ok: false, code: "ROOM_COUNT_INVALID" });
    expect(resolveRoomChoice({ capacity: rooms, partySize: 4, roomCount: 1.5, requireAcknowledgement: true })).toMatchObject({ ok: false, code: "ROOM_COUNT_INVALID" });
  });

  it("allows no more rooms than are available, and says how many are", () => {
    const refused = resolveRoomChoice({ capacity: rooms, partySize: 6, roomCount: 3, roomsAvailable: 2, requireAcknowledgement: true });
    expect(refused).toMatchObject({ ok: false, code: "ROOM_COUNT_INVALID" });
    expect(!refused.ok && refused.message).toMatch(/Only 2 rooms are free/);
    expect(resolveRoomChoice({ capacity: rooms, partySize: 6, roomCount: 2, roomsAvailable: 2, bringsExtraBedding: true, requireAcknowledgement: true })).toMatchObject({ ok: true, roomCount: 2 });
    expect(resolveRoomChoice({ capacity: rooms, partySize: 6, roomCount: 3, roomsAvailable: null, requireAcknowledgement: true })).toMatchObject({ ok: true, roomCount: 3 });
  });

  it("allows a party larger than the beds, once the registrant acknowledges bringing extra bedding", () => {
    expect(partyExceedsBeds(rooms, 5, 2)).toBe(true);
    expect(partyExceedsBeds(rooms, 4, 2)).toBe(false);
    expect(partyExceedsBeds({ roomBased: false, unitCapacity: 2 }, 9, 1)).toBe(false);
    const needs = resolveRoomChoice({ capacity: rooms, partySize: 5, roomCount: 2, requireAcknowledgement: true });
    expect(needs).toMatchObject({ ok: false, code: "EXTRA_BEDDING_NOT_ACKNOWLEDGED" });
    expect(resolveRoomChoice({ capacity: rooms, partySize: 5, roomCount: 2, bringsExtraBedding: true, requireAcknowledgement: true })).toEqual({ ok: true, roomCount: 2, bringsExtraBedding: true, extraBeddingNeeded: true });
    // Staff do not have to acknowledge, and the flag still records it.
    expect(resolveRoomChoice({ capacity: rooms, partySize: 5, roomCount: 2, requireAcknowledgement: false })).toMatchObject({ ok: true, bringsExtraBedding: true });
    // The flag is never stored when it does not apply.
    expect(resolveRoomChoice({ capacity: rooms, partySize: 4, roomCount: 2, bringsExtraBedding: true, requireAcknowledgement: true })).toMatchObject({ ok: true, bringsExtraBedding: false });
  });

  it("words the note as the issue asks", () => {
    expect(extraBeddingNote(1)).toBe("Your party is larger than the beds in 1 room; you're welcome to bring extra bedding.");
    expect(extraBeddingNote(3)).toBe("Your party is larger than the beds in 3 rooms; you're welcome to bring extra bedding.");
  });
});

const offer: LodgingStepOffer = {
  nights: ["2027-06-15", "2027-06-16", "2027-06-17", "2027-06-18"],
  deadline: "2027-06-01",
  fullBehavior: "SHOW_FULL",
  categories: [
    { category: "DORM_ROOM", label: "Dorm room", remaining: { "2027-06-15": 5, "2027-06-16": 0, "2027-06-17": 5, "2027-06-18": 5 }, rate: rate("PER_UNIT_NIGHT", 2000, 2), unitCapacity: 2, roomBased: true },
    { category: "TENT", label: "Tent", remaining: { "2027-06-15": null, "2027-06-16": null, "2027-06-17": null, "2027-06-18": null }, rate: rate("PER_PERSON_PER_EVENT", 4000) },
    { category: "CONFERENCE_CENTER_ROOM", label: "Conference center room", remaining: { "2027-06-15": 2, "2027-06-16": 2, "2027-06-17": 2, "2027-06-18": 2 }, rate: null, unitCapacity: 2, roomBased: true },
  ],
};
const choice = (overrides: Partial<LodgingChoice> = {}): LodgingChoice => ({ ...defaultLodgingChoice(offer, 2), ...overrides });

describe("the lodging step of the form", () => {
  it("is a step before review, and only where it is turned on", () => {
    const plain = getPublicRegistrationStepPlan(formDefinition);
    expect(plain.some((step) => step.isLodging)).toBe(false);
    const withStep = getPublicRegistrationStepPlan(formDefinition, undefined, { lodging: true });
    expect(withStep.map((step) => step.id)).toEqual(["sec_1", "__lodging", "__review"]);
    expect(withStep[1]).toMatchObject({ isLodging: true, isReview: false, sectionId: null, fieldKeys: [] });
  });

  it("starts with no type, the whole stay and everyone on the registration", () => {
    expect(defaultLodgingChoice(offer, 3)).toMatchObject({ category: "", firstNight: "2027-06-15", lastNight: "2027-06-18", partySize: 3, groundFloorNeeded: false, accessibleRoomNeeded: false });
    expect(chosenNights(choice())).toHaveLength(4);
    expect(chosenNights(choice({ firstNight: "2027-06-17", lastNight: "2027-06-16" }))).toEqual([]);
  });

  it("shows a type as full for the nights chosen: no free room on a night for a room-type category, too few places for any other", () => {
    const all = chosenNights(choice());
    expect(categoryIsFull(offer, "DORM_ROOM", all, 2)).toBe(true);
    expect(categoryIsFull(offer, "DORM_ROOM", all, 1)).toBe(true);
    expect(categoryIsFull(offer, "DORM_ROOM", ["2027-06-17", "2027-06-18"], 9)).toBe(false); // the party is not the count: rooms are
    expect(categoryIsFull(offer, "DORM_ROOM", ["2027-06-17", "2027-06-18"], 9, 6)).toBe(true); // six rooms asked, five free
    expect(categoryIsFull(offer, "DORM_ROOM", ["2027-06-17", "2027-06-18"], 2, 2)).toBe(false);
    expect(categoryIsFull(offer, "TENT", all, 40)).toBe(false);
    expect(categoryIsFull(offer, "RV_SITE", all, 1)).toBe(true);
  });

  it("asks how many rooms for a room-type category only, from one up to the party and the rooms free", () => {
    const nights = { firstNight: "2027-06-17", lastNight: "2027-06-18" };
    expect(roomQuestion(offer, choice({ category: "TENT" }))).toMatchObject({ asked: false, highest: 1 });
    expect(roomQuestion(offer, choice({ category: "" }))).toMatchObject({ asked: false });
    expect(roomQuestion(offer, choice({ category: "DORM_ROOM", partySize: 4, roomCount: 2, ...nights }))).toMatchObject({ asked: true, highest: 4, extraBeddingNeeded: false, problem: null });
    // Five rooms are free on those nights, so a party of eight may ask for at most five.
    expect(roomQuestion(offer, choice({ category: "DORM_ROOM", partySize: 8, roomCount: 5, bringsExtraBedding: true, ...nights }))).toMatchObject({ asked: true, highest: 5, extraBeddingNeeded: false });
    expect(clampedRoomCount(offer, choice({ category: "DORM_ROOM", partySize: 8, roomCount: 7, ...nights }))).toBe(5);
    expect(clampedRoomCount(offer, choice({ category: "DORM_ROOM", partySize: 2, roomCount: 7, ...nights }))).toBe(2);
    expect(clampedRoomCount(offer, choice({ category: "TENT", roomCount: 3 }))).toBe(1);
  });

  it("shows the extra-bedding note, and needs the acknowledgement, when the party is larger than the beds in the chosen rooms", () => {
    const nights = { firstNight: "2027-06-17", lastNight: "2027-06-18" };
    const party = choice({ category: "DORM_ROOM", partySize: 5, roomCount: 2, ...nights }); // 2 rooms of 2 beds, 5 people
    expect(roomQuestion(offer, party)).toMatchObject({ asked: true, extraBeddingNeeded: true });
    expect(lodgingStepProblem(offer, party, 5)).toMatch(/^Lodging step: Your party is larger than the beds in 2 rooms/);
    const acknowledged = { ...party, bringsExtraBedding: true };
    expect(lodgingStepProblem(offer, acknowledged, 5)).toBeNull();
    expect(lodgingStepInput(offer, acknowledged)).toMatchObject({ category: "DORM_ROOM", partySize: 5, roomCount: 2, bringsExtraBedding: true });
    // More rooms remove the note, and the flag is not sent.
    const enough = choice({ category: "DORM_ROOM", partySize: 5, roomCount: 3, bringsExtraBedding: true, ...nights });
    expect(roomQuestion(offer, enough).extraBeddingNeeded).toBe(false);
    expect(lodgingStepInput(offer, enough)).toMatchObject({ roomCount: 3 });
    expect(lodgingStepInput(offer, { ...enough, partySize: 5 })).toHaveProperty("bringsExtraBedding", true); // the server drops a flag that does not apply
  });

  it("prices the rooms chosen, not a party divided by a room size", () => {
    const nights = { firstNight: "2027-06-17", lastNight: "2027-06-18" };
    expect(lodgingStepLine(offer, choice({ category: "DORM_ROOM", partySize: 6, roomCount: 1, bringsExtraBedding: true, ...nights }))).toMatchObject({ amountCents: 2000 * 2 * 1, label: "Lodging: Dorm room" });
    expect(lodgingStepLine(offer, choice({ category: "DORM_ROOM", partySize: 6, roomCount: 3, ...nights }))).toMatchObject({ amountCents: 2000 * 2 * 3, label: "Lodging: Dorm room (3 rooms)" });
  });

  it("refuses a room count above the rooms free", () => {
    const nights = { firstNight: "2027-06-17", lastNight: "2027-06-18" };
    expect(lodgingStepProblem(offer, choice({ category: "DORM_ROOM", partySize: 8, roomCount: 6, bringsExtraBedding: true, ...nights }), 8)).toMatch(/Only 5 rooms are free/);
  });

  it("reports what cannot be submitted, naming the step", () => {
    expect(lodgingStepProblem(offer, choice(), 2)).toBeNull();
    expect(lodgingStepProblem(offer, choice({ category: "DORM_ROOM" }), 2)).toMatch(/^Lodging step: Dorm room is full/);
    expect(lodgingStepProblem(offer, choice({ category: "DORM_ROOM", partySize: 1, firstNight: "2027-06-15", lastNight: "2027-06-15" }), 2)).toMatch(/^Lodging step: Dorm room needs at least 2 nights/);
    expect(lodgingStepProblem(offer, choice({ firstNight: "2027-06-18", lastNight: "2027-06-15" }), 2)).toMatch(/last night/);
    expect(lodgingStepProblem(offer, choice({ partySize: 3 }), 2)).toMatch(/choose how many/);
    expect(lodgingStepProblem(offer, choice({ category: "TENT", roommates: [{ name: "Pat Example", confirmationCode: "", fromClientId: "" }] }), 2)).toMatch(/both the name and the confirmation code/);
  });

  it("prices the choice, and a type with no rate adds no line", () => {
    expect(lodgingStepLine(offer, choice({ category: "TENT", partySize: 2 }))).toMatchObject({ key: "lodging", amountCents: 8000 });
    expect(lodgingStepLine(offer, choice({ category: "DORM_ROOM", partySize: 1, firstNight: "2027-06-17", lastNight: "2027-06-18" }))).toMatchObject({ amountCents: 4000 });
    expect(lodgingStepLine(offer, choice({ category: "CONFERENCE_CENTER_ROOM" }))).toBeNull();
    expect(lodgingStepLine(offer, choice())).toBeNull();
  });

  it("builds the submission: the whole event as no window, a partial stay as its nights, and only complete roommate rows", () => {
    expect(lodgingStepInput(offer, choice({ category: "TENT" }))).toMatchObject({ category: "TENT", firstNight: null, lastNight: null, partySize: 2 });
    expect(lodgingStepInput(offer, choice({ category: "TENT", firstNight: "2027-06-16", lastNight: "2027-06-17" }))).toMatchObject({ firstNight: "2027-06-16", lastNight: "2027-06-17" });
    const input = lodgingStepInput(offer, choice({ category: "TENT", roommates: [{ name: " Pat Example ", confirmationCode: " REG-ABCDEF123456 ", fromClientId: "" }, { name: "", confirmationCode: "", fromClientId: "" }], within: [{ fromClientId: "a", targetClientId: "b" }] }));
    expect(input.roommates).toEqual([{ name: "Pat Example", confirmationCode: "REG-ABCDEF123456" }]);
    expect(input.roommatesWithin).toEqual([{ fromClientId: "a", targetClientId: "b" }]);
    expect(lodgingStepInput(offer, choice()).category).toBeNull();
  });
});

describe("the submission and the promo quote carry the lodging step", () => {
  const base = { versionId: "v1", idempotencyKey: "0b6c2d1a-7a52-4f1d-9d3f-6d6f5f7a0001", responses: {}, website: "" };

  it("accepts the step, strictly: yes/no flags and no free text", () => {
    expect(publicRegistrationInputSchema.safeParse({ ...base, lodging: { category: "TENT", groundFloorNeeded: true } }).success).toBe(true);
    expect(publicRegistrationInputSchema.safeParse({ ...base, lodging: { category: "TENT", medicalReason: "knee surgery" } }).success).toBe(false);
    expect(publicRegistrationInputSchema.safeParse({ ...base, lodging: { category: "TENT", groundFloorNeeded: "first-floor, medical" } }).success).toBe(false);
    expect(publicRegistrationInputSchema.safeParse({ ...base, lodging: { category: "TENT", roommates: [{ name: "Pat Example", confirmationCode: "REG-ABCDEF123456", email: "x@example.test" }] } }).success).toBe(false);
  });

  it("limits roommate requests", () => {
    const row = { name: "Pat Example", confirmationCode: "REG-ABCDEF123456" };
    expect(publicRegistrationInputSchema.safeParse({ ...base, lodging: { category: "TENT", roommates: [row, row, row, row, row, row] } }).success).toBe(false);
  });

  it("lets a promo quote price the same lodging", () => {
    expect(publicPromoCodeQuoteInputSchema.safeParse({ versionId: "v1", code: "TENOFF", responses: {}, lodging: { category: "DORM_ROOM", partySize: 2 } }).success).toBe(true);
    expect(publicPromoCodeQuoteInputSchema.safeParse({ versionId: "v1", code: "TENOFF", responses: {}, lodging: { category: "DORM_ROOM", price: 1 } }).success).toBe(false);
  });
});
