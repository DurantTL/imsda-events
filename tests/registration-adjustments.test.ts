import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  registrationFindFirst: vi.fn(),
  registrationUpdate: vi.fn(),
  adjustmentAggregate: vi.fn(),
  adjustmentFindFirst: vi.fn(),
  adjustmentCreate: vi.fn(),
  promoUpdateMany: vi.fn(),
  userFindUnique: vi.fn(),
  writeAuditLog: vi.fn(),
  claimPromoCode: vi.fn(),
  getRegistrationById: vi.fn(),
}));

const tx = {
  registration: { findFirst: mocks.registrationFindFirst, update: mocks.registrationUpdate },
  registrationAdjustment: { aggregate: mocks.adjustmentAggregate, findFirst: mocks.adjustmentFindFirst, create: mocks.adjustmentCreate },
  promoCode: { updateMany: mocks.promoUpdateMany },
  user: { findUnique: mocks.userFindUnique },
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({ $transaction: async (work: (client: typeof tx) => unknown) => work(tx) }) }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/registrations/repository", () => ({ getRegistrationById: mocks.getRegistrationById }));
vi.mock("@/modules/promo-codes/repository", () => {
  class PublicPromoCodeError extends Error {}
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
    payments: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.registrationFindFirst.mockResolvedValue(registration());
  mocks.adjustmentAggregate.mockResolvedValue({ _sum: { amountCents: null } });
  mocks.adjustmentFindFirst.mockResolvedValue(null);
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
});
