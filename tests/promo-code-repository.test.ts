import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  claimPromoCode,
  PromoCodeOperationError,
  PublicPromoCodeError,
  recordPromoCodeRedemption,
} from "@/modules/promo-codes/repository";

function storedPromo(overrides: Record<string, unknown> = {}) {
  return {
    id: "promo_1",
    eventId: "event_1",
    code: "LASTSPOT",
    normalizedCode: "LASTSPOT",
    isActive: true,
    discountType: "FIXED_CENTS" as const,
    discountValue: 1_000,
    startsOn: null,
    endsOn: null,
    minimumSubtotalCents: null,
    maximumUses: 1,
    maximumDiscountCents: null,
    redeemedCount: 0,
    createdAt: new Date("2026-07-01T12:00:00.000Z"),
    updatedAt: new Date("2026-07-01T12:00:00.000Z"),
    ...overrides,
  };
}

describe("promo-code redemption repository", () => {
  it("claims a use through an optimistic atomic increment", async () => {
    const promo = storedPromo();
    const tx = {
      promoCode: {
        findUnique: vi.fn().mockResolvedValue(promo),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const claimed = await claimPromoCode(tx as never, {
      eventId: "event_1",
      submittedCode: "lastspot",
      eligibleSubtotalCents: 12_500,
      pricingDate: "2026-08-01",
      fieldId: "promo_field",
    });

    expect(tx.promoCode.updateMany).toHaveBeenCalledWith({
      where: {
        id: "promo_1",
        eventId: "event_1",
        isActive: true,
        AND: [
          { redeemedCount: 0 },
          { redeemedCount: { lt: 1 } },
        ],
      },
      data: { redeemedCount: { increment: 1 } },
    });
    expect(claimed).toMatchObject({
      pricingDate: "2026-08-01",
      evaluation: {
        valid: true,
        discountAmountCents: 1_000,
      },
    });
  });

  it("turns a lost final-use race into a field-safe use-limit error", async () => {
    const available = storedPromo();
    const exhausted = storedPromo({ redeemedCount: 1 });
    const tx = {
      promoCode: {
        findUnique: vi.fn()
          .mockResolvedValueOnce(available)
          .mockResolvedValueOnce(exhausted),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };

    await expect(claimPromoCode(tx as never, {
      eventId: "event_1",
      submittedCode: "LASTSPOT",
      eligibleSubtotalCents: 12_500,
      pricingDate: "2026-08-01",
      fieldId: "promo_field",
    })).rejects.toMatchObject({
      reason: "USE_LIMIT_REACHED",
      fieldId: "promo_field",
    } satisfies Partial<PublicPromoCodeError>);
  });

  it("marks a non-limit compare-and-swap miss as retryable by the outer serializable workflow", async () => {
    const promo = storedPromo({ maximumUses: 10 });
    const tx = {
      promoCode: {
        findUnique: vi.fn().mockResolvedValue(promo),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };

    await expect(claimPromoCode(tx as never, {
      eventId: "event_1",
      submittedCode: "LASTSPOT",
      eligibleSubtotalCents: 12_500,
      pricingDate: "2026-08-01",
      fieldId: "promo_field",
    })).rejects.toMatchObject({
      code: "PROMO_CODE_CLAIM_CONFLICT",
    } satisfies Partial<PromoCodeOperationError>);
  });

  it("persists immutable rule and amount snapshots on the registration", async () => {
    const create = vi.fn().mockResolvedValue({ id: "redemption_1" });
    const tx = { promoCodeRedemption: { create } };
    await recordPromoCodeRedemption(tx as never, {
      eventId: "event_1",
      registrationId: "registration_1",
      claimed: {
        promoCode: storedPromo(),
        pricingDate: "2026-08-01",
        evaluation: {
          valid: true,
          code: "LASTSPOT",
          normalizedCode: "LASTSPOT",
          eligibleSubtotalCents: 12_500,
          discountAmountCents: 1_000,
        },
      },
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventId: "event_1",
        registrationId: "registration_1",
        promoCodeId: "promo_1",
        codeSnapshot: "LASTSPOT",
        maximumUsesSnapshot: 1,
        eligibleSubtotalCents: 12_500,
        discountAmountCents: 1_000,
        pricingDate: "2026-08-01",
      }),
    });
  });
});

