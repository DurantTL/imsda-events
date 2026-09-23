import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  registrationFindFirst: vi.fn(),
  registrationUpdate: vi.fn(),
  adjustmentAggregate: vi.fn(),
  adjustmentFindFirst: vi.fn(),
  adjustmentFindMany: vi.fn(),
  adjustmentCreate: vi.fn(),
  promoUpdateMany: vi.fn(),
  userFindUnique: vi.fn(),
  writeAuditLog: vi.fn(),
  claimPromoCode: vi.fn(),
  getRegistrationById: vi.fn(),
}));

const tx = {
  registration: { findFirst: mocks.registrationFindFirst, update: mocks.registrationUpdate },
  registrationAdjustment: { aggregate: mocks.adjustmentAggregate, findFirst: mocks.adjustmentFindFirst, findMany: mocks.adjustmentFindMany, create: mocks.adjustmentCreate },
  promoCode: { updateMany: mocks.promoUpdateMany },
  user: { findUnique: mocks.userFindUnique },
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({ $transaction: async (work: (client: typeof tx) => unknown) => work(tx) }) }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/registrations/repository", () => ({ getRegistrationById: mocks.getRegistrationById }));
vi.mock("@/modules/promo-codes/repository", () => {
  class PublicPromoCodeError extends Error {
    constructor(public readonly reason: string, message: string) {
      super(message);
    }
  }
  class PromoCodeOperationError extends Error {}
  return { claimPromoCode: mocks.claimPromoCode, PublicPromoCodeError, PromoCodeOperationError };
});

import {
  createAdjustmentSchema,
  createRegistrationAdjustment,
  reverseRegistrationAdjustment,
} from "@/modules/registrations/adjustments";
import { PublicPromoCodeError } from "@/modules/promo-codes/repository";

function registration(overrides: Record<string, unknown> = {}) {
  return {
    id: "reg-1",
    confirmationCode: "REG-1",
    status: "SUBMITTED",
    totalAmount: 145,
    submittedAt: new Date("2026-06-01T15:00:00Z"),
    createdAt: new Date("2026-06-01T15:00:00Z"),
    promoCodeRedemption: null,
    attendees: [
      { id: "att-1", profileSnapshot: { firstName: "Ann", lastName: "Lee" }, person: { firstName: "Ann", lastName: "Lee" } },
      { id: "att-2", profileSnapshot: { firstName: "Sara", lastName: "Lee" }, person: { firstName: "Sara", lastName: "Lee" } },
    ],
    publicFormSubmission: { pricingSnapshot: { lineItems: [
      { key: "fee-0", amountCents: 14500, attendeeIndex: 0 },
      { key: "fee-1", amountCents: 12500, attendeeIndex: 1 },
    ] } },
    operations: [],
    payments: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.registrationFindFirst.mockResolvedValue(registration());
  mocks.adjustmentAggregate.mockResolvedValue({ _sum: { amountCents: null } });
  mocks.adjustmentFindFirst.mockResolvedValue(null);
  mocks.adjustmentFindMany.mockResolvedValue([]);
  mocks.adjustmentCreate.mockResolvedValue({ id: "adj-1" });
  mocks.userFindUnique.mockResolvedValue({ displayName: "Finance Staff" });
  mocks.getRegistrationById.mockResolvedValue({ id: "reg-1" });
});

describe("registration adjustments (#396)", () => {
  it("a scholarship lowers the total and is audited without names", async () => {
    await createRegistrationAdjustment("event-1", "reg-1", "user-1", createAdjustmentSchema.parse({
      kind: "SCHOLARSHIP", amountCents: 5000, reason: "Committee scholarship",
    }));
    expect(mocks.adjustmentCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: "SCHOLARSHIP", amountCents: -5000, createdByNameSnapshot: "Finance Staff" }) });
    expect(mocks.registrationUpdate).toHaveBeenCalledWith({ where: { id: "reg-1" }, data: { totalAmount: 95 } });
    expect(mocks.writeAuditLog.mock.calls[0]![0]).toMatchObject({
      action: "REGISTRATION_ADJUSTMENT_ADDED",
      metadata: expect.objectContaining({ totalBeforeCents: 14500, totalAfterCents: 9500 }),
    });
  });

  it("a correction can raise the amount owed", async () => {
    await createRegistrationAdjustment("event-1", "reg-1", "user-1", createAdjustmentSchema.parse({
      kind: "CORRECTION", amountCents: 1000, reason: "Missed a meal charge",
    }));
    expect(mocks.registrationUpdate).toHaveBeenCalledWith({ where: { id: "reg-1" }, data: { totalAmount: 155 } });
  });

  it("refuses to go below zero or below what was paid", async () => {
    await expect(createRegistrationAdjustment("event-1", "reg-1", "user-1", {
      kind: "DISCOUNT", amountCents: 20000, reason: "Too much",
    })).rejects.toMatchObject({ code: "TOTAL_BELOW_ZERO" });

    mocks.registrationFindFirst.mockResolvedValue(registration({ payments: [{ amount: 100, refunds: [] }] }));
    await expect(createRegistrationAdjustment("event-1", "reg-1", "user-1", {
      kind: "SCHOLARSHIP", amountCents: 5000, reason: "After payment",
    })).rejects.toMatchObject({ code: "TOTAL_BELOW_PAID" });
    expect(mocks.adjustmentCreate).not.toHaveBeenCalled();
  });

  it("applies a promo code against the priced total on the registration date", async () => {
    mocks.adjustmentAggregate.mockResolvedValue({ _sum: { amountCents: -1000 } });
    mocks.registrationFindFirst.mockResolvedValue(registration({ totalAmount: 135 }));
    mocks.claimPromoCode.mockResolvedValue({ promoCode: { id: "promo-1", code: "EARLY" }, evaluation: { discountAmountCents: 1450 } });
    await createRegistrationAdjustment("event-1", "reg-1", "user-1", { kind: "PROMO_CODE", code: "early", reason: "Registered in early window" });
    expect(mocks.claimPromoCode).toHaveBeenCalledWith(tx, expect.objectContaining({ eligibleSubtotalCents: 14500, pricingDate: "2026-06-01" }));
    expect(mocks.adjustmentCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ amountCents: -1450, promoCodeSnapshot: "EARLY" }) });
    expect(mocks.registrationUpdate).toHaveBeenCalledWith({ where: { id: "reg-1" }, data: { totalAmount: 120.5 } });
  });

  it("explains an invalid code, and allows only one code per registration", async () => {
    mocks.claimPromoCode.mockRejectedValue(new PublicPromoCodeError("ENDED", "That promo code ended on 2026-05-01."));
    await expect(createRegistrationAdjustment("event-1", "reg-1", "user-1", { kind: "PROMO_CODE", code: "OLD", reason: "Try it" }))
      .rejects.toMatchObject({ code: "PROMO_INVALID", message: "That promo code ended on 2026-05-01." });

    mocks.registrationFindFirst.mockResolvedValue(registration({ promoCodeRedemption: { id: "red-1" } }));
    await expect(createRegistrationAdjustment("event-1", "reg-1", "user-1", { kind: "PROMO_CODE", code: "EARLY", reason: "Second code" }))
      .rejects.toMatchObject({ code: "PROMO_ALREADY_APPLIED" });
    await expect(createRegistrationAdjustment("event-1", "reg-1", "user-1", { kind: "PROMO_CODE", code: "EARLY", reason: "On top", attendeeId: "att-1" }))
      .rejects.toMatchObject({ code: "PROMO_ALREADY_APPLIED" });
  });

  it("reverses with an opposite line and gives a promo use back", async () => {
    mocks.registrationFindFirst.mockResolvedValue(registration({ totalAmount: 130.5 }));
    mocks.adjustmentFindFirst.mockResolvedValue({ id: "adj-1", kind: "PROMO_CODE", amountCents: -1450, promoCodeId: "promo-1", promoCodeSnapshot: "EARLY", reversesAdjustmentId: null, reversedBy: null });
    await reverseRegistrationAdjustment("event-1", "reg-1", "adj-1", "user-1", "Applied by mistake");
    expect(mocks.adjustmentCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ amountCents: 1450, reversesAdjustmentId: "adj-1" }) });
    expect(mocks.promoUpdateMany).toHaveBeenCalledWith({ where: { id: "promo-1", redeemedCount: { gt: 0 } }, data: { redeemedCount: { decrement: 1 } } });
    expect(mocks.registrationUpdate).toHaveBeenCalledWith({ where: { id: "reg-1" }, data: { totalAmount: 145 } });

    mocks.adjustmentFindFirst.mockResolvedValue({ id: "adj-1", kind: "DISCOUNT", amountCents: -100, promoCodeId: null, promoCodeSnapshot: null, reversesAdjustmentId: null, reversedBy: { id: "adj-2" } });
    await expect(reverseRegistrationAdjustment("event-1", "reg-1", "adj-1", "user-1", "Again"))
      .rejects.toMatchObject({ code: "ADJUSTMENT_ALREADY_REVERSED" });
  });

  it("only adjusts active registrations", async () => {
    mocks.registrationFindFirst.mockResolvedValue(registration({ status: "CANCELLED" }));
    await expect(createRegistrationAdjustment("event-1", "reg-1", "user-1", { kind: "DISCOUNT", amountCents: 100, reason: "Nope" }))
      .rejects.toMatchObject({ code: "REGISTRATION_NOT_ADJUSTABLE" });
  });

  it("prices a per-person code on that person's share, one code each (#397)", async () => {
    mocks.registrationFindFirst.mockResolvedValue(registration({ totalAmount: 270 }));
    mocks.claimPromoCode.mockResolvedValue({ promoCode: { id: "promo-1", code: "EARLY" }, evaluation: { discountAmountCents: 1250 } });
    await createRegistrationAdjustment("event-1", "reg-1", "user-1", { kind: "PROMO_CODE", code: "EARLY", reason: "Early bird", attendeeId: "att-2" });
    expect(mocks.claimPromoCode).toHaveBeenCalledWith(tx, expect.objectContaining({ eligibleSubtotalCents: 12500 }));
    expect(mocks.adjustmentCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ amountCents: -1250, registrationAttendeeId: "att-2" }) });

    mocks.adjustmentFindMany.mockResolvedValue([{ registrationAttendeeId: "att-2" }]);
    await expect(createRegistrationAdjustment("event-1", "reg-1", "user-1", { kind: "PROMO_CODE", code: "EARLY", reason: "Again", attendeeId: "att-2" }))
      .rejects.toMatchObject({ code: "PROMO_ALREADY_APPLIED", message: expect.stringContaining("Sara Lee already has a promo code") });
    // A whole-registration code can't be added on top of per-person codes.
    await expect(createRegistrationAdjustment("event-1", "reg-1", "user-1", { kind: "PROMO_CODE", code: "EARLY", reason: "Whole" }))
      .rejects.toMatchObject({ code: "PROMO_ALREADY_APPLIED" });
    // The other person can still have their own.
    await createRegistrationAdjustment("event-1", "reg-1", "user-1", { kind: "PROMO_CODE", code: "EARLY", reason: "Early bird", attendeeId: "att-1" });
    expect(mocks.claimPromoCode).toHaveBeenLastCalledWith(tx, expect.objectContaining({ eligibleSubtotalCents: 14500 }));
  });

  it("refuses a per-person code when there's no per-person price, or an unknown person", async () => {
    mocks.registrationFindFirst.mockResolvedValue(registration({ publicFormSubmission: null }));
    await expect(createRegistrationAdjustment("event-1", "reg-1", "user-1", { kind: "PROMO_CODE", code: "EARLY", reason: "x y", attendeeId: "att-1" }))
      .rejects.toMatchObject({ code: "ATTENDEE_PRICE_UNKNOWN" });
    await expect(createRegistrationAdjustment("event-1", "reg-1", "user-1", { kind: "SCHOLARSHIP", amountCents: 100, reason: "x y", attendeeId: "nobody" }))
      .rejects.toMatchObject({ code: "ATTENDEE_NOT_FOUND" });
  });
});
