import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  authorizeRegistrationAccessToken: vi.fn(),
  enqueuePaymentReceiptMessage: vi.fn(),
  enqueueRefundNoticeMessage: vi.fn(),
  processQueuedMessageIdsAfterCommit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/public-access/repository", () => ({
  authorizeRegistrationAccessToken:
    dependencies.authorizeRegistrationAccessToken,
}));
vi.mock("@/modules/communications/transactional-messages", () => ({
  enqueuePaymentReceiptMessage: dependencies.enqueuePaymentReceiptMessage,
  enqueueRefundNoticeMessage: dependencies.enqueueRefundNoticeMessage,
}));
vi.mock("@/modules/communications/messaging-repository", () => ({
  processQueuedMessageIdsAfterCommit:
    dependencies.processQueuedMessageIdsAfterCommit,
}));

import type { SquareRuntimeConfiguration } from "@/modules/payments/square-config";
import type { ParsedSquareWebhookEvent } from "@/modules/payments/square-domain";
import { processSquareWebhook } from "@/modules/payments/square-repository";

const configuration: SquareRuntimeConfiguration = {
  environment: "production",
  applicationId: "sq0idb-example",
  locationId: "main-location",
  accessToken: "access-token",
  apiUrl: "https://connect.squareup.com",
  apiVersion: "2026-07-15",
  scriptUrl: "https://web.squarecdn.com/v1/square.js",
  webhookSignatureKey: "signature-key",
  webhookNotificationUrl: "https://events.imsda.test/api/webhooks/square",
  paymentConfigured: true,
  webhookConfigured: true,
  issue: null,
};

/** An imported registration owing $80, with nothing paid yet. */
function payableRegistration(overrides: Record<string, unknown> = {}) {
  return {
    id: "registration-9",
    eventId: "event-1",
    confirmationCode: "WR26-4417",
    totalAmount: 80,
    payments: [],
    ...overrides,
  };
}

function transactionClient() {
  return {
    registration: {
      findMany: vi.fn().mockResolvedValue([payableRegistration()]),
    },
    paymentAttempt: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    payment: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "payment-9" }),
    },
    squareWebhookEvent: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
}

function prismaFor(tx: ReturnType<typeof transactionClient>) {
  return {
    $transaction: vi.fn(async (
      operation: (client: typeof tx) => unknown,
    ) => operation(tx)),
  };
}

/** A payment taken in Square outside the app — an invoice or payment link. */
function externalPaymentEvent(
  payment: Record<string, unknown> = {},
): ParsedSquareWebhookEvent {
  return {
    providerEventId: "square-event-ext-1",
    eventType: "payment.updated",
    occurredAt: new Date("2026-07-23T14:00:00.000Z"),
    kind: "PAYMENT",
    payment: {
      id: "square-payment-ext-1",
      status: "COMPLETED",
      amount_money: { amount: 8_000, currency: "USD" },
      location_id: "main-location",
      note: "Womens Retreat balance WR26-4417",
      created_at: "2026-07-23T13:59:00.000Z",
      ...payment,
    } as ParsedSquareWebhookEvent["payment"],
  };
}

async function run(
  tx: ReturnType<typeof transactionClient>,
  event = externalPaymentEvent(),
) {
  dependencies.getPrisma.mockReturnValue(prismaFor(tx));
  return processSquareWebhook(event, "f".repeat(64), { configuration });
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.enqueuePaymentReceiptMessage.mockResolvedValue({
    pendingMessageIds: ["receipt-ext-1"],
  });
  dependencies.processQueuedMessageIdsAfterCommit.mockResolvedValue({
    capturedIds: [],
    sentIds: [],
    failedIds: [],
    rescheduledIds: [],
    skippedIds: [],
  });
});

describe("Square payments taken outside IMSDA Events", () => {
  it("applies a completed payment whose note names one registration and settles it exactly", async () => {
    const tx = transactionClient();

    const result = await run(tx);

    expect(result).toMatchObject({
      status: "PROCESSED",
      paymentStatus: "SUCCEEDED",
    });
    expect(tx.payment.create).toHaveBeenCalledWith({
      data: {
        eventId: "event-1",
        registrationId: "registration-9",
        amount: 80,
        status: "SUCCEEDED",
        method: "CARD_REFERENCE",
        externalReference: "square-payment-ext-1",
        receivedAt: new Date("2026-07-23T13:59:00.000Z"),
      },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "SQUARE_EXTERNAL_PAYMENT_APPLIED",
      }),
    }));
    expect(dependencies.enqueuePaymentReceiptMessage).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        registrationId: "registration-9",
        amountCents: 8_000,
        providerPaymentId: "square-payment-ext-1",
      }),
    );
    expect(dependencies.processQueuedMessageIdsAfterCommit)
      .toHaveBeenCalledWith(["receipt-ext-1"]);
  });

  it("reads the confirmation code out of the reference when the note has none", async () => {
    const tx = transactionClient();

    await run(tx, externalPaymentEvent({
      note: "Paid at the office",
      reference_id: "wr26-4417",
    }));

    expect(tx.registration.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          confirmationCode: { in: expect.arrayContaining(["WR26-4417"]) },
        }),
      }),
    );
    expect(tx.payment.create).toHaveBeenCalled();
  });

  it("subtracts what was already paid before comparing the amount", async () => {
    const tx = transactionClient();
    tx.registration.findMany.mockResolvedValue([payableRegistration({
      payments: [{ amount: 30, refunds: [] }],
    })]);

    const applied = await run(tx, externalPaymentEvent({
      amount_money: { amount: 5_000, currency: "USD" },
    }));

    expect(applied).toMatchObject({ status: "PROCESSED" });
    expect(tx.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: 50 }) }),
    );
  });

  it.each([
    [
      "a payment Square has not completed",
      externalPaymentEvent({ status: "PENDING" }),
      "pending",
    ],
    [
      "a payment in another currency",
      externalPaymentEvent({ amount_money: { amount: 8_000, currency: "CAD" } }),
      "not in USD",
    ],
    [
      "a note and reference with no confirmation code",
      externalPaymentEvent({ note: "Womens Retreat balance", reference_id: undefined }),
      "no confirmation code",
    ],
    [
      "an amount that is not the outstanding balance",
      externalPaymentEvent({ amount_money: { amount: 7_500, currency: "USD" } }),
      "does not equal the outstanding balance",
    ],
  ])("records but does not apply %s", async (_label, event, reason) => {
    const tx = transactionClient();

    const result = await run(tx, event);

    expect(result).toEqual({ status: "IGNORED", duplicate: false });
    expect(tx.payment.create).not.toHaveBeenCalled();
    expect(dependencies.enqueuePaymentReceiptMessage).not.toHaveBeenCalled();
    expect(tx.squareWebhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "IGNORED",
          reason: expect.stringContaining(reason),
        }),
      }),
    );
  });

  it("refuses to guess when the confirmation code matches more than one registration", async () => {
    const tx = transactionClient();
    tx.registration.findMany.mockResolvedValue([
      payableRegistration(),
      payableRegistration({ id: "registration-10", eventId: "event-2" }),
    ]);

    const result = await run(tx);

    expect(result).toEqual({ status: "IGNORED", duplicate: false });
    expect(tx.payment.create).not.toHaveBeenCalled();
  });

  it("refuses to apply against a registration that is not payable", async () => {
    const tx = transactionClient();
    tx.registration.findMany.mockResolvedValue([]);

    const result = await run(tx);

    expect(tx.registration.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["SUBMITTED", "CONFIRMED"] },
        }),
      }),
    );
    expect(result).toEqual({ status: "IGNORED", duplicate: false });
  });

  it("does not record the same provider payment twice across created and updated", async () => {
    const tx = transactionClient();
    tx.payment.findFirst.mockResolvedValue({
      id: "payment-9",
      eventId: "event-1",
    });

    const result = await run(tx, externalPaymentEvent());

    expect(result).toEqual({ status: "PROCESSED", duplicate: false });
    expect(tx.payment.create).not.toHaveBeenCalled();
    expect(dependencies.enqueuePaymentReceiptMessage).not.toHaveBeenCalled();
  });

  it("leaves a payment taken at another Square location alone", async () => {
    const tx = transactionClient();

    const result = await run(tx, externalPaymentEvent({
      location_id: "some-other-location",
    }));

    expect(result).toEqual({ status: "IGNORED", duplicate: false });
    expect(tx.registration.findMany).not.toHaveBeenCalled();
    expect(tx.payment.create).not.toHaveBeenCalled();
  });
});
