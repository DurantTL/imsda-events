import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  transaction: vi.fn(),
  getRegistrationById: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    payment: {
      findFirst: mocks.findFirst,
    },
    $transaction: mocks.transaction,
  }),
}));

vi.mock("@/modules/registrations/repository", () => ({
  getRegistrationById: mocks.getRegistrationById,
}));

import {
  PaymentOperationError,
  recordRefund,
} from "@/modules/payments/repository";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("manual refund safety", () => {
  it("requires Square card refunds to be issued through Square", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "payment_square",
      eventId: "event_1",
      registrationId: "registration_1",
      amount: 129.3,
      method: "CARD_REFERENCE",
      refunds: [],
      registration: {
        confirmationCode: "WR26-TEST",
      },
    });

    await expect(recordRefund(
      "event_1",
      "payment_square",
      "user_1",
      {
        amountCents: 1_000,
        reason: "Registrant request",
      },
    )).rejects.toMatchObject({
      code: "CARD_REFUND_REQUIRES_SQUARE",
    } satisfies Partial<PaymentOperationError>);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
