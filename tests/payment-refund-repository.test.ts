import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  refundFindFirst: vi.fn(),
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
    refund: { findFirst: mocks.refundFindFirst },
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
        idempotencyKey: "key-operation-1",
      },
    )).rejects.toMatchObject({
      code: "CARD_REFUND_REQUIRES_SQUARE",
    } satisfies Partial<PaymentOperationError>);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  function manualPayment() {
    return {
      id: "payment_manual",
      eventId: "event_1",
      registrationId: "registration_1",
      amount: 129.3,
      method: "CASH",
      registration: { confirmationCode: "WR26-TEST" },
    };
  }

  function makeTx(overrides: { existing?: unknown; refunded?: number[] } = {}) {
    return {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "payment_manual" }]),
      refund: {
        findFirst: vi.fn().mockResolvedValue(overrides.existing ?? null),
        findMany: vi.fn().mockResolvedValue((overrides.refunded ?? []).map((amount) => ({ amount }))),
        create: vi.fn().mockResolvedValue({ id: "refund_manual" }),
      },
      auditLog: { create: vi.fn() },
    };
  }

  const input = { amountCents: 1_000, reason: "Registrant request", idempotencyKey: "key-operation-1" };

  it("creates one notice intent for a successful manual refund", async () => {
    const tx = makeTx();
    mocks.findFirst.mockResolvedValue(manualPayment());
    mocks.transaction.mockImplementation(async (callback) => callback(tx));
    mocks.enqueueRefundNoticeMessage.mockResolvedValue({
      pendingMessageIds: ["message_manual"],
    });
    mocks.getRegistrationById.mockResolvedValue({ id: "registration_1" });

    await recordRefund("event_1", "payment_manual", "user_1", input);

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.refund.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ idempotencyKey: "key-operation-1", amount: 10 }),
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

  it("records nothing more when the same operation is retried", async () => {
    const tx = makeTx({ existing: { amount: 10, reason: "Registrant request" } });
    mocks.findFirst.mockResolvedValue(manualPayment());
    mocks.transaction.mockImplementation(async (callback) => callback(tx));
    mocks.getRegistrationById.mockResolvedValue({ id: "registration_1" });

    const result = await recordRefund("event_1", "payment_manual", "user_1", input);

    expect(result).toEqual({ id: "registration_1" });
    expect(tx.refund.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { paymentId: "payment_manual", idempotencyKey: "key-operation-1" },
    }));
    expect(tx.refund.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(mocks.enqueueRefundNoticeMessage).not.toHaveBeenCalled();
  });

  it("records distinct operations separately up to the balance", async () => {
    mocks.findFirst.mockResolvedValue(manualPayment());
    mocks.enqueueRefundNoticeMessage.mockResolvedValue({ pendingMessageIds: [] });
    mocks.getRegistrationById.mockResolvedValue({ id: "registration_1" });

    const first = makeTx();
    mocks.transaction.mockImplementationOnce(async (callback) => callback(first));
    await recordRefund("event_1", "payment_manual", "user_1", input);

    const second = makeTx({ refunded: [10] });
    mocks.transaction.mockImplementationOnce(async (callback) => callback(second));
    await recordRefund("event_1", "payment_manual", "user_1", { ...input, idempotencyKey: "key-operation-2" });

    expect(first.refund.create).toHaveBeenCalledTimes(1);
    expect(second.refund.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ idempotencyKey: "key-operation-2" }),
    });
  });

  it("rejects a new operation that exceeds the balance left inside the transaction", async () => {
    const tx = makeTx({ refunded: [129.3] });
    mocks.findFirst.mockResolvedValue(manualPayment());
    mocks.transaction.mockImplementation(async (callback) => callback(tx));

    await expect(recordRefund("event_1", "payment_manual", "user_1", input)).rejects.toMatchObject({
      code: "REFUND_EXCEEDS_AVAILABLE",
    });
    expect(tx.refund.create).not.toHaveBeenCalled();
  });

  it("rejects a reused key with a different amount or reason", async () => {
    mocks.findFirst.mockResolvedValue(manualPayment());
    for (const existing of [
      { amount: 20, reason: "Registrant request" },
      { amount: 10, reason: "Different reason" },
    ]) {
      const tx = makeTx({ existing });
      mocks.transaction.mockImplementationOnce(async (callback) => callback(tx));
      await expect(recordRefund("event_1", "payment_manual", "user_1", input)).rejects.toMatchObject({
        code: "REFUND_IDEMPOTENCY_KEY_REUSED",
      });
      expect(tx.refund.create).not.toHaveBeenCalled();
    }
  });

  it("falls through to the replay path when the unique index fires", async () => {
    mocks.findFirst.mockResolvedValue(manualPayment());
    mocks.transaction.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    mocks.refundFindFirst.mockResolvedValueOnce({ amount: 10, reason: "Registrant request" });
    mocks.getRegistrationById.mockResolvedValue({ id: "registration_1" });

    await expect(recordRefund("event_1", "payment_manual", "user_1", input)).resolves.toEqual({ id: "registration_1" });
    expect(mocks.enqueueRefundNoticeMessage).not.toHaveBeenCalled();

    mocks.transaction.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    mocks.refundFindFirst.mockResolvedValueOnce({ amount: 99, reason: "Registrant request" });
    await expect(recordRefund("event_1", "payment_manual", "user_1", input)).rejects.toMatchObject({
      code: "REFUND_IDEMPOTENCY_KEY_REUSED",
    });
  });
});
