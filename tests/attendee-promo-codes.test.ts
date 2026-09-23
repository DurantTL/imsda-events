import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), updateMany: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));

const client = { promoCode: { findUnique: mocks.findUnique, updateMany: mocks.updateMany } };

import { applyAttendeePromoCodes, attendeeShareCents } from "@/modules/promo-codes/domain";
import { evaluateAttendeePromoCodes } from "@/modules/promo-codes/repository";
import type { FormCalculation, RegistrationFormDefinition } from "@/modules/forms/definition";

const calculation: FormCalculation = {
  subtotalCents: 27000,
  processingFeeCents: 0,
  totalCents: 27000,
  lineItems: [
    { key: "fee-0", label: "Registration", amountCents: 14500, attendeeIndex: 0 },
    { key: "fee-1", label: "Registration", amountCents: 12500, attendeeIndex: 1 },
  ],
};

function promo(overrides: Record<string, unknown> = {}) {
  return {
    id: "promo-early",
    code: "EARLY",
    normalizedCode: "EARLY",
    isActive: true,
    discountType: "FIXED_CENTS",
    discountValue: 2000,
    startsOn: null,
    endsOn: null,
    minimumSubtotalCents: null,
    maximumUses: null,
    maximumDiscountCents: null,
    redeemedCount: 0,
    ...overrides,
  };
}

const field = { id: "field-promo", key: "promo_code" };
const attendees = (codes: string[]) => codes.map((code) => ({ responses: { promo_code: code } }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue(promo());
  mocks.updateMany.mockResolvedValue({ count: 1 });
});

describe("per-person promo codes (#397)", () => {
  it("prices each code on that person's share", async () => {
    mocks.findUnique.mockResolvedValue(promo({ discountType: "PERCENT_BPS", discountValue: 1000 }));
    const { discounts, issues } = await evaluateAttendeePromoCodes(client as never, {
      eventId: "event-1", field, attendees: attendees(["early", "early"]), calculation, pricingDate: "2026-06-01", claim: false,
    });
    expect(issues).toEqual([]);
    expect(discounts.map((discount) => discount.discountAmountCents)).toEqual([1450, 1250]);
    expect(attendeeShareCents(calculation, 1)).toBe(12500);
  });

  it("warns when the same code is entered more times than it has uses left", async () => {
    mocks.findUnique.mockResolvedValue(promo({ maximumUses: 5, redeemedCount: 4 }));
    const { discounts, issues } = await evaluateAttendeePromoCodes(client as never, {
      eventId: "event-1", field, attendees: attendees(["EARLY", "EARLY"]), calculation, pricingDate: "2026-06-01", claim: false,
    });
    expect(discounts).toHaveLength(1);
    expect(issues).toEqual([expect.objectContaining({
      attendeeIndex: 1,
      path: "attendees.1.responses.promo_code",
      message: "EARLY has no uses left for another person in this registration.",
    })]);
  });

  it("explains unknown or expired codes on that person, and skips blank ones", async () => {
    mocks.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(promo({ endsOn: "2026-05-01" }));
    const { discounts, issues } = await evaluateAttendeePromoCodes(client as never, {
      eventId: "event-1", field, attendees: [...attendees(["NOPE", "EARLY"]), { responses: {} }], calculation, pricingDate: "2026-06-01", claim: false,
    });
    expect(discounts).toEqual([]);
    expect(issues.map((issue) => [issue.attendeeIndex, issue.message])).toEqual([
      [0, "That promo code was not recognized. Check the spelling and try again."],
      [1, "That promo code ended on 2026-05-01."],
    ]);
  });

  it("claims one use per person at submission", async () => {
    const { discounts } = await evaluateAttendeePromoCodes(client as never, {
      eventId: "event-1", field, attendees: attendees(["EARLY", "EARLY"]), calculation, pricingDate: "2026-06-01", claim: true,
    });
    expect(mocks.updateMany).toHaveBeenCalledTimes(2);
    expect(discounts.every((discount) => discount.promoCodeId === "promo-early")).toBe(true);
  });

  it("totals the discounts and recalculates the card fee on the discounted amount", () => {
    const definition = {
      payment: { enabled: true, currency: "USD", paymentMethodFieldKey: "payment_method", cardOptionValue: "Card", passFeeToRegistrant: true, percentageBasisPoints: 290, fixedFeeCents: 30 },
    } as unknown as RegistrationFormDefinition;
    const priced = applyAttendeePromoCodes(definition, { payment_method: "Card" }, calculation, [
      { attendeeIndex: 0, code: "EARLY", discountAmountCents: 2000 },
      { attendeeIndex: 1, code: "CHURCH", discountAmountCents: 12500 },
    ]);
    expect(priced.discountAmountCents).toBe(14500);
    expect(priced.subtotalCents).toBe(12500);
    expect(priced.promoCode).toBe("EARLY, CHURCH");
    expect(priced.processingFeeCents).toBeGreaterThan(0);
    expect(priced.totalCents).toBe(priced.subtotalCents + priced.processingFeeCents);
  });
});
