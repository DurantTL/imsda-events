import { describe, expect, it } from "vitest";
import { lodgingRateBases, quoteStay, rateSchema, type LodgingRate } from "@/modules/lodging/domain";
import { addUndiscountedLine, calculationWithLine, registrationFormDefinitionSchema, type FormCalculation } from "@/modules/forms/definition";
import { getPublicRegistrationStepPlan } from "@/modules/forms/public-registration-steps";
import { publicRegistrationInputSchema } from "@/modules/forms/public-domain";
import { applyPromoCodeToCalculation, attendeeShareCents, evaluatePromoCode, type PromoCodeRule } from "@/modules/promo-codes/domain";
import { publicPromoCodeQuoteInputSchema } from "@/modules/promo-codes/schemas";
import {
  categoryIsFull,
  chosenNights,
  defaultLodgingChoice,
  lodgingStepInput,
  lodgingStepLine,
  lodgingStepProblem,
  type LodgingChoice,
  type LodgingStepOffer,
} from "@/modules/lodging/form-step";
import { LODGING_LINE_KEY, lodgingCharge, unitsForParty } from "@/modules/lodging/pricing";

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

  it("is never discounted by a promo code: the discount is decided on the form's own lines and the line joins afterwards", () => {
    const rule: PromoCodeRule = {
      isActive: true, normalizedCode: "TENOFF", discountType: "PERCENT_BPS", discountValue: 1000, maximumDiscountCents: null,
      minimumSubtotalCents: null, startsAt: null, endsAt: null, maximumUses: null, redeemedCount: 0,
    } as unknown as PromoCodeRule;
    const evaluation = evaluatePromoCode(rule, { submittedCode: "tenoff", eligibleSubtotalCents: formCalculation().subtotalCents, pricingDate: "2027-05-20", hideAmounts: false });
    expect(evaluation.valid).toBe(true);
    if (!evaluation.valid) return;
    const discounted = applyPromoCodeToCalculation(formDefinition, {}, formCalculation(), evaluation);
    expect(discounted.discountAmountCents).toBe(500);
    const total = addUndiscountedLine(formDefinition, {}, discounted, line);
    expect(total.lineItems.map((item) => item.key)).toEqual(["registration_fee", "lodging"]);
    expect(total.discountAmountCents).toBe(500);
    expect(total.subtotalCents).toBe(discounted.subtotalCents + 7500);
    expect(total.totalCents).toBe(5000 - 500 + 7500);
    // Adding it again replaces it and never counts it twice.
    expect(addUndiscountedLine(formDefinition, {}, total, { ...line, amountCents: 2000 }).totalCents).toBe(5000 - 500 + 2000);
  });

  it("adds the line after a full sponsorship and the processing fee follows the final subtotal", () => {
    const sponsored = { ...formCalculation(), subtotalCents: 0, totalCents: 0, discountAmountCents: 5000, preDiscountSubtotalCents: 5000, lineItems: formCalculation().lineItems };
    const total = addUndiscountedLine(formDefinition, { payment_method: "Card" }, sponsored, line);
    expect(total.subtotalCents).toBe(7500);
    expect(total.preDiscountSubtotalCents).toBe(12_500);
    expect(total.processingFeeCents).toBeGreaterThan(0);
    expect(total.totalCents).toBe(total.subtotalCents + total.processingFeeCents);
  });

  it("has no attendee, so a per-person code never reaches it", () => {
    const withLodging = calculationWithLine(formDefinition, {}, formCalculation(), line.key, line);
    const roster: FormCalculation = { ...withLodging, lineItems: [{ key: "meal", label: "Meal", amountCents: 1000, attendeeIndex: 0 }, ...withLodging.lineItems] };
    expect(attendeeShareCents(roster, 0)).toBe(1000);
  });
});

describe("rooms for a party", () => {
  it("is the party divided by the room size, rounded up, and never below one", () => {
    expect(unitsForParty(6, 2)).toBe(3);
    expect(unitsForParty(5, 2)).toBe(3);
    expect(unitsForParty(1, 4)).toBe(1);
    expect(unitsForParty(3, null)).toBe(1);
    expect(unitsForParty(3, undefined)).toBe(1);
  });

  it("charges a per-room rate for each room and says how many in the label", () => {
    const six = lodgingCharge({ category: "DORM_ROOM", nights: 2, partySize: 6, rates: { DORM_ROOM: rate("PER_UNIT_NIGHT", 2000) }, units: unitsForParty(6, 2) });
    expect(six.kind === "CHARGE" && six.line).toMatchObject({ amountCents: 12_000, label: "Lodging: Dorm room (3 rooms)" });
    const flat = lodgingCharge({ category: "DORM_ROOM", nights: 2, partySize: 6, rates: { DORM_ROOM: rate("PER_UNIT_PER_EVENT", 3000) }, units: 3 });
    expect(flat.kind === "CHARGE" && flat.line.amountCents).toBe(9000);
    const one = lodgingCharge({ category: "DORM_ROOM", nights: 2, partySize: 2, rates: { DORM_ROOM: rate("PER_UNIT_NIGHT", 2000) }, units: 1 });
    expect(one.kind === "CHARGE" && one.line.label).toBe("Lodging: Dorm room");
  });

  it("does not multiply a per-person rate by rooms", () => {
    const person = lodgingCharge({ category: "DORM_ROOM", nights: 2, partySize: 6, rates: { DORM_ROOM: rate("PER_PERSON_NIGHT", 1000) }, units: 3 });
    expect(person.kind === "CHARGE" && person.line.amountCents).toBe(12_000);
  });
});

const offer: LodgingStepOffer = {
  nights: ["2027-06-15", "2027-06-16", "2027-06-17", "2027-06-18"],
  deadline: "2027-06-01",
  fullBehavior: "SHOW_FULL",
  categories: [
    { category: "DORM_ROOM", label: "Dorm room", remaining: { "2027-06-15": 5, "2027-06-16": 1, "2027-06-17": 5, "2027-06-18": 5 }, rate: rate("PER_UNIT_NIGHT", 2000, 2) },
    { category: "TENT", label: "Tent", remaining: { "2027-06-15": null, "2027-06-16": null, "2027-06-17": null, "2027-06-18": null }, rate: rate("PER_PERSON_PER_EVENT", 4000) },
    { category: "CONFERENCE_CENTER_ROOM", label: "Conference center room", remaining: { "2027-06-15": 2, "2027-06-16": 2, "2027-06-17": 2, "2027-06-18": 2 }, rate: null },
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

  it("shows a type as full for the nights and party chosen", () => {
    const all = chosenNights(choice());
    expect(categoryIsFull(offer, "DORM_ROOM", all, 2)).toBe(true);
    expect(categoryIsFull(offer, "DORM_ROOM", all, 1)).toBe(false);
    expect(categoryIsFull(offer, "DORM_ROOM", ["2027-06-17", "2027-06-18"], 2)).toBe(false);
    expect(categoryIsFull(offer, "TENT", all, 40)).toBe(false);
    expect(categoryIsFull(offer, "RV_SITE", all, 1)).toBe(true);
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
