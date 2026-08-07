import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  transaction: vi.fn(),
  getRegistrationById: vi.fn(),
  enqueueRefundNoticeMessage: vi.fn(),
  processQueuedMessageIdsAfterCommit: vi.fn(),
}));

vi.mock("server-only", () => ({}));

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

vi.mock("@/modules/communications/transactional-messages", () => ({
  enqueueRefundNoticeMessage: mocks.enqueueRefundNoticeMessage,
}));

vi.mock("@/modules/communications/messaging-repository", () => ({
  processQueuedMessageIdsAfterCommit: mocks.processQueuedMessageIdsAfterCommit,
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

  it("creates one notice intent for a successful manual refund", async () => {
    const tx = {
      refund: { create: vi.fn().mockResolvedValue({ id: "refund_manual" }) },
      auditLog: { create: vi.fn() },
    };
    mocks.findFirst.mockResolvedValue({
      id: "payment_manual",
      eventId: "event_1",
      registrationId: "registration_1",
      amount: 129.3,
      method: "CASH",
      refunds: [],
      registration: { confirmationCode: "WR26-TEST" },
    });
    mocks.transaction.mockImplementation(async (callback) => callback(tx));
    mocks.enqueueRefundNoticeMessage.mockResolvedValue({
      pendingMessageIds: ["message_manual"],
    });
    mocks.getRegistrationById.mockResolvedValue({ id: "registration_1" });

    await recordRefund("event_1", "payment_manual", "user_1", {
      amountCents: 1_000,
      reason: "Registrant request",
    });

    expect(mocks.enqueueRefundNoticeMessage).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        refundId: "refund_manual",
        amountCents: 1_000,
        provider: "MANUAL",
      }),
    );
    expect(mocks.processQueuedMessageIdsAfterCommit).toHaveBeenCalledWith([
      "message_manual",
    ]);
  });
});
