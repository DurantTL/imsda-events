import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  authorizeRegistrationAccessToken: vi.fn(),
  enqueuePaymentReceiptMessage: vi.fn(),
  processQueuedMessageIdsAfterCommit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/public-access/repository", () => ({
  authorizeRegistrationAccessToken:
    dependencies.authorizeRegistrationAccessToken,
}));
vi.mock("@/modules/communications/transactional-messages", () => ({
  enqueuePaymentReceiptMessage:
    dependencies.enqueuePaymentReceiptMessage,
}));
vi.mock("@/modules/communications/messaging-repository", () => ({
  processQueuedMessageIdsAfterCommit:
    dependencies.processQueuedMessageIdsAfterCommit,
}));

import { SquareAdapterError } from "@/modules/payments/square-adapter";
import type { SquareRuntimeConfiguration } from "@/modules/payments/square-config";
import {
  createPublicSquarePayment,
  getPublicSquareCheckout,
  processSquareWebhook,
} from "@/modules/payments/square-repository";
import type { ParsedSquareWebhookEvent } from "@/modules/payments/square-domain";

const configuration: SquareRuntimeConfiguration = {
  environment: "sandbox",
  applicationId: "sandbox-sq0idb-example",
  locationId: "sandbox-location",
  accessToken: "sandbox-access-token",
  apiUrl: "https://connect.squareupsandbox.com",
  apiVersion: "2026-07-15",
  scriptUrl: "https://sandbox.web.squarecdn.com/v1/square.js",
  webhookSignatureKey: "sandbox-signature-key",
  webhookNotificationUrl: "https://events.imsda.test/api/webhooks/square",
  paymentConfigured: true,
  webhookConfigured: true,
  issue: null,
};

const formDefinition = {
  title: "Square repository test",
  description: "",
  confirmationMessage: "Received.",
  payment: {
    enabled: true,
    currency: "USD",
    paymentMethodFieldKey: "payment_method",
    cardOptionValue: "Credit / debit card",
    percentageBasisPoints: 290,
    fixedFeeCents: 30,
    passFeeToRegistrant: true,
  },
  sections: [{
    id: "payment-section",
    title: "Payment",
    description: "",
    fields: [{
      id: "payment-method",
      key: "payment_method",
      label: "Payment method",
      helpText: "",
      type: "RADIO",
      scope: "REGISTRATION",
      required: true,
      options: ["Pay later", "Credit / debit card"],
    }],
  }],
};

function registration() {
  return {
    id: "registration-1",
    eventId: "event-1",
    confirmationCode: "REG-ONE",
    status: "CONFIRMED",
    totalAmount: 100,
    contactSnapshot: {
      firstName: "Test",
      lastName: "Registrant",
      email: "test.registrant@example.test",
      phone: "",
    },
    accountHolderPerson: {
      firstName: "Test",
      lastName: "Registrant",
      normalizedEmail: "test.registrant@example.test",
      phone: null,
    },
    payments: [{
      amount: 20,
      refunds: [],
    }],
    paymentAttempts: [],
    waitlistEntry: null,
    paymentChoiceOperations: [],
    publicFormSubmission: {
      responses: { payment_method: "Credit / debit card" },
      pricingSnapshot: {
        currency: "USD",
        subtotalCents: 10_000,
      },
      formVersion: {
        status: "PUBLISHED",
        definition: formDefinition,
      },
    },
  };
}

function processingAttempt() {
  return {
    id: "attempt-1",
    eventId: "event-1",
    registrationId: "registration-1",
    registrationAccessTokenId: "access-1",
    paymentId: null,
    provider: "SQUARE",
    environment: "sandbox",
    clientIdempotencyKey: "d67776d0-f79d-4e8f-bec2-ee61abb7337c",
    providerIdempotencyKey: "imsda_stable_provider_key",
    activeRegistrationKey: "registration-1",
    amountCents: 8_000,
    currency: "USD",
    status: "PROCESSING",
    providerPaymentId: null,
    providerStatus: null,
    providerStatusAt: null,
    failureCode: null,
    failureMessage: null,
    requestCount: 1,
    lastRequestedAt: new Date("2026-07-23T13:00:00.000Z"),
    completedAt: null,
    createdAt: new Date("2026-07-23T13:00:00.000Z"),
    updatedAt: new Date("2026-07-23T13:00:00.000Z"),
    payment: null,
    registration: { confirmationCode: "REG-ONE" },
  };
}

function transactionClient() {
  return {
    registration: {
      findUnique: vi.fn().mockResolvedValue(registration()),
    },
    paymentAttempt: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    payment: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    refund: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    squareWebhookEvent: {
      findUnique: vi.fn(),
      create: vi.fn().mockResolvedValue({}),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  };
}

function prismaFor(tx: ReturnType<typeof transactionClient>) {
  return {
    $transaction: vi.fn(async (
      operation: (client: typeof tx) => unknown,
    ) => operation(tx)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.enqueuePaymentReceiptMessage.mockResolvedValue({
    messageIds: ["receipt-1"],
    pendingMessageIds: ["receipt-1"],
    deliveryMode: "LOCAL_CAPTURE",
    skippedReason: null,
  });
  dependencies.processQueuedMessageIdsAfterCommit.mockResolvedValue({
    capturedIds: ["receipt-1"],
    sentIds: [],
    failedIds: [],
    rescheduledIds: [],
    skippedIds: [],
  });
  dependencies.authorizeRegistrationAccessToken.mockResolvedValue({
    accessTokenId: "access-1",
    registrationId: "registration-1",
    eventId: "event-1",
    registrationStatus: "CONFIRMED",
  });
});

describe("Square payment repository", () => {
  it("returns a browser-safe card checkout from the server-owned balance", async () => {
    const client = transactionClient();

    const checkout = await getPublicSquareCheckout("a".repeat(43), {
      client: client as never,
      configuration,
    });

    expect(checkout).toMatchObject({
      state: "READY",
      amountCents: 8_000,
      cardSelected: true,
      square: {
        environment: "sandbox",
        applicationId: "sandbox-sq0idb-example",
        locationId: "sandbox-location",
      },
    });
    expect(JSON.stringify(checkout)).not.toContain("sandbox-access-token");
  });

  it("requires an explicit choice after promotion and quotes both totals", async () => {
    const client = transactionClient();
    const promoted = {
      ...registration(),
      status: "SUBMITTED",
      totalAmount: 80,
      payments: [],
      waitlistEntry: { status: "PROMOTED" },
      paymentChoiceOperations: [],
      publicFormSubmission: {
        responses: {
          email: "test.registrant@example.test",
          promo_code: "SAVE20",
        },
        pricingSnapshot: {
          currency: "USD",
          preDiscountSubtotalCents: 10_000,
          discountAmountCents: 2_000,
          promoCode: "SAVE20",
          subtotalCents: 8_000,
          processingFeeCents: 0,
          totalCents: 8_000,
        },
        formVersion: {
          status: "ARCHIVED",
          definition: formDefinition,
        },
      },
    };
    client.registration.findUnique.mockResolvedValue(promoted);

    const checkout = await getPublicSquareCheckout("a".repeat(43), {
      client: client as never,
      configuration,
    });

    expect(checkout).toMatchObject({
      state: "CHOICE_REQUIRED",
      amountCents: 8_000,
      cardSelected: false,
      paymentChoice: {
        available: true,
        locked: false,
        selected: null,
        currentOperationId: null,
        baseSubtotalCents: 8_000,
        cardProcessingFeeCents: 270,
        cardTotalCents: 8_270,
        payLaterTotalCents: 8_000,
      },
    });
  });

  it("enables Square only after the durable promoted choice is card", async () => {
    const client = transactionClient();
    client.registration.findUnique.mockResolvedValue({
      ...registration(),
      status: "SUBMITTED",
      totalAmount: 82.70,
      payments: [],
      waitlistEntry: { status: "PROMOTED" },
      paymentChoiceOperations: [{
        id: "04a18ff0-a05a-487a-9e1b-8bd7d01adb05",
        choice: "CARD",
        baseSubtotalCents: 8_000,
        processingFeeCents: 270,
        resultingTotalCents: 8_270,
      }],
      publicFormSubmission: {
        responses: {
          email: "test.registrant@example.test",
          promo_code: "SAVE20",
        },
        pricingSnapshot: {
          currency: "USD",
          subtotalCents: 8_000,
        },
        formVersion: {
          status: "ARCHIVED",
          definition: formDefinition,
        },
      },
    });

    const checkout = await getPublicSquareCheckout("a".repeat(43), {
      client: client as never,
      configuration,
    });

    expect(checkout).toMatchObject({
      state: "READY",
      amountCents: 8_270,
      cardSelected: true,
      paymentChoice: {
        selected: "CARD",
        currentOperationId:
          "04a18ff0-a05a-487a-9e1b-8bd7d01adb05",
      },
    });
  });

  it("charges the immutable database balance and never persists the source token", async () => {
    const tx = transactionClient();
    const prisma = prismaFor(tx);
    const attempt = processingAttempt();
    const succeeded = {
      ...attempt,
      paymentId: "payment-1",
      activeRegistrationKey: null,
      status: "SUCCEEDED",
      providerPaymentId: "square-payment-1",
      providerStatus: "COMPLETED",
      providerStatusAt: new Date("2026-07-23T13:00:01.000Z"),
      completedAt: new Date("2026-07-23T13:00:01.000Z"),
      payment: {
        id: "payment-1",
        eventId: "event-1",
        registrationId: "registration-1",
        amount: 80,
        status: "SUCCEEDED",
        method: "CARD_REFERENCE",
        externalReference: "square-payment-1",
        receivedAt: new Date("2026-07-23T13:00:01.000Z"),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };
    tx.paymentAttempt.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(attempt);
    tx.paymentAttempt.create.mockResolvedValue(attempt);
    tx.paymentAttempt.update.mockResolvedValue(succeeded);
    tx.payment.create.mockResolvedValue(succeeded.payment);
    dependencies.getPrisma.mockReturnValue(prisma);
    const adapter = vi.fn().mockResolvedValue({
      id: "square-payment-1",
      status: "COMPLETED",
      amountCents: 8_000,
      currency: "USD",
      createdAt: "2026-07-23T13:00:00.000Z",
      updatedAt: "2026-07-23T13:00:01.000Z",
    });

    const result = await createPublicSquarePayment(
      "a".repeat(43),
      {
        sourceId: "cnon:card-nonce-ok",
        idempotencyKey: attempt.clientIdempotencyKey,
      },
      {
        configuration,
        createPayment: adapter,
        now: new Date("2026-07-23T13:00:01.000Z"),
      },
    );

    expect(result).toMatchObject({
      status: "SUCCEEDED",
      amountCents: 8_000,
    });
    expect(adapter).toHaveBeenCalledWith(
      configuration,
      expect.objectContaining({
        sourceId: "cnon:card-nonce-ok",
        amountCents: 8_000,
        idempotencyKey: attempt.providerIdempotencyKey,
        referenceId: attempt.id,
      }),
    );
    const durableWrites = JSON.stringify({
      attempt: tx.paymentAttempt.create.mock.calls,
      payment: tx.payment.create.mock.calls,
      audit: tx.auditLog.create.mock.calls,
    });
    expect(durableWrites).not.toContain("cnon:card-nonce-ok");
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: "Serializable" },
    );
    expect(dependencies.enqueuePaymentReceiptMessage).toHaveBeenCalledWith(
      tx,
      {
        eventId: "event-1",
        registrationId: "registration-1",
        paymentId: "payment-1",
        paymentAttemptId: "attempt-1",
        amountCents: 8_000,
        providerPaymentId: "square-payment-1",
      },
    );
    expect(dependencies.processQueuedMessageIdsAfterCommit)
      .toHaveBeenCalledWith(["receipt-1"]);
  });

  it("returns a completed attempt without calling Square again", async () => {
    const tx = transactionClient();
    const prisma = prismaFor(tx);
    const existing = {
      ...processingAttempt(),
      activeRegistrationKey: null,
      status: "SUCCEEDED",
      providerPaymentId: "square-payment-1",
    };
    tx.paymentAttempt.findUnique.mockResolvedValue(existing);
    dependencies.getPrisma.mockReturnValue(prisma);
    const adapter = vi.fn();

    const result = await createPublicSquarePayment(
      "a".repeat(43),
      {
        sourceId: "cnon:a-new-token-is-irrelevant",
        idempotencyKey: existing.clientIdempotencyKey,
      },
      { configuration, createPayment: adapter },
    );

    expect(result.status).toBe("SUCCEEDED");
    expect(adapter).not.toHaveBeenCalled();
    expect(tx.paymentAttempt.create).not.toHaveBeenCalled();
    expect(dependencies.enqueuePaymentReceiptMessage).not.toHaveBeenCalled();
  });

  it("keeps an indeterminate provider request active for a safe idempotent retry", async () => {
    const tx = transactionClient();
    const prisma = prismaFor(tx);
    const attempt = processingAttempt();
    const uncertainAttempt = {
      ...attempt,
      failureCode: "SQUARE_REQUEST_UNCERTAIN",
      failureMessage: "Square did not confirm the request.",
    };
    tx.paymentAttempt.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(attempt);
    tx.paymentAttempt.create.mockResolvedValue(attempt);
    tx.paymentAttempt.update.mockResolvedValue(uncertainAttempt);
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(createPublicSquarePayment(
      "a".repeat(43),
      {
        sourceId: "cnon:card-nonce-ok",
        idempotencyKey: attempt.clientIdempotencyKey,
      },
      {
        configuration,
        createPayment: vi.fn().mockRejectedValue(
          new SquareAdapterError(
            "SQUARE_REQUEST_UNCERTAIN",
            "Square did not confirm the request.",
            true,
          ),
        ),
      },
    )).rejects.toMatchObject({
      code: "PAYMENT_RESULT_UNCERTAIN",
      retryable: true,
    });
    expect(tx.paymentAttempt.update).toHaveBeenCalledWith({
      where: { id: attempt.id },
      data: expect.not.objectContaining({
        status: "FAILED",
        activeRegistrationKey: null,
      }),
      include: expect.any(Object),
    });
  });

  it("applies and deduplicates a completed Square payment webhook", async () => {
    const tx = transactionClient();
    const prisma = prismaFor(tx);
    const attempt = processingAttempt();
    const providerPayment = {
      id: "payment-1",
      eventId: "event-1",
      registrationId: "registration-1",
      amount: 80,
      status: "SUCCEEDED",
      method: "CARD_REFERENCE",
      externalReference: "square-payment-1",
      receivedAt: new Date("2026-07-23T13:00:01.000Z"),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    tx.squareWebhookEvent.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: "PROCESSED" });
    tx.paymentAttempt.findFirst.mockResolvedValue(attempt);
    tx.payment.create.mockResolvedValue(providerPayment);
    tx.paymentAttempt.update.mockResolvedValue({
      ...attempt,
      status: "SUCCEEDED",
      paymentId: providerPayment.id,
      payment: providerPayment,
    });
    dependencies.getPrisma.mockReturnValue(prisma);
    const event: ParsedSquareWebhookEvent = {
      providerEventId: "square-event-1",
      eventType: "payment.updated",
      occurredAt: new Date("2026-07-23T13:00:01.000Z"),
      kind: "PAYMENT",
      payment: {
        id: "square-payment-1",
        status: "COMPLETED",
        amount_money: { amount: 8_000, currency: "USD" },
        location_id: "sandbox-location",
        reference_id: attempt.id,
      },
    };

    const first = await processSquareWebhook(
      event,
      "a".repeat(64),
      { configuration },
    );
    const duplicate = await processSquareWebhook(
      event,
      "a".repeat(64),
      { configuration },
    );

    expect(first).toMatchObject({
      status: "PROCESSED",
      duplicate: false,
      paymentStatus: "SUCCEEDED",
    });
    expect(duplicate).toEqual({
      status: "PROCESSED",
      duplicate: true,
    });
    expect(tx.squareWebhookEvent.create).toHaveBeenCalledTimes(1);
    const durableEvent = tx.squareWebhookEvent.create.mock.calls[0][0].data;
    expect(durableEvent).toMatchObject({
      providerEventId: "square-event-1",
      payloadHash: "a".repeat(64),
      status: "PROCESSED",
    });
    expect(durableEvent).not.toHaveProperty("payload");
    expect(dependencies.enqueuePaymentReceiptMessage).toHaveBeenCalledTimes(1);
    expect(dependencies.processQueuedMessageIdsAfterCommit)
      .toHaveBeenCalledTimes(1);
  });

  it("records a completed Square refund against its card payment", async () => {
    const tx = transactionClient();
    const prisma = prismaFor(tx);
    tx.squareWebhookEvent.findUnique.mockResolvedValue(null);
    tx.payment.findFirst.mockResolvedValue({
      id: "payment-1",
      eventId: "event-1",
      registrationId: "registration-1",
      amount: 80,
      status: "SUCCEEDED",
      method: "CARD_REFERENCE",
      externalReference: "square-payment-1",
      paymentAttempt: { id: "attempt-1" },
      refunds: [],
      registration: { confirmationCode: "REG-ONE" },
    });
    tx.refund.findFirst.mockResolvedValue(null);
    tx.refund.create.mockResolvedValue({
      id: "refund-1",
      eventId: "event-1",
      paymentId: "payment-1",
      amount: 25,
      status: "SUCCEEDED",
      externalReference: "square-refund-1",
      reason: "Square card refund",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    dependencies.getPrisma.mockReturnValue(prisma);
    const event: ParsedSquareWebhookEvent = {
      providerEventId: "square-refund-event-1",
      eventType: "refund.updated",
      occurredAt: new Date("2026-07-23T14:00:00.000Z"),
      kind: "REFUND",
      refund: {
        id: "square-refund-1",
        status: "COMPLETED",
        amount_money: { amount: 2_500, currency: "USD" },
        payment_id: "square-payment-1",
        location_id: "sandbox-location",
      },
    };

    const result = await processSquareWebhook(
      event,
      "b".repeat(64),
      { configuration },
    );

    expect(result).toMatchObject({
      status: "PROCESSED",
      refundStatus: "SUCCEEDED",
    });
    expect(tx.refund.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventId: "event-1",
        paymentId: "payment-1",
        amount: 25,
        status: "SUCCEEDED",
        externalReference: "square-refund-1",
      }),
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "SQUARE_REFUND_COMPLETED",
      }),
    });
  });
});
