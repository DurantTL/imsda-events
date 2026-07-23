import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  paymentChoiceRequestFingerprint,
  type PaymentChoiceInput,
} from "@/modules/payments/payment-choice-domain";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  authorizeRegistrationAccessToken: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/public-access/repository", () => ({
  authorizeRegistrationAccessToken:
    dependencies.authorizeRegistrationAccessToken,
}));

import {
  choosePublicPromotedWaitlistPayment,
} from "@/modules/payments/payment-choice-repository";

const input: PaymentChoiceInput = {
  choice: "CARD",
  clientRequestId: "19af978c-b75a-4860-9df5-e9110dc2671e",
  expectedPriorOperationId: null,
};

const definition = {
  title: "Promoted waitlist payment",
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

function promotedRegistration(overrides: Record<string, unknown> = {}) {
  return {
    id: "registration-1",
    eventId: "event-1",
    confirmationCode: "REG-PROMOTED",
    status: "SUBMITTED",
    totalAmount: 80,
    waitlistEntry: { status: "PROMOTED" },
    publicFormSubmission: {
      pricingSnapshot: {
        currency: "USD",
        preDiscountSubtotalCents: 10_000,
        discountAmountCents: 2_000,
        promoCode: "SAVE20",
        subtotalCents: 8_000,
        processingFeeCents: 0,
        totalCents: 8_000,
      },
      formVersion: { definition },
    },
    paymentAttempts: [],
    payments: [],
    paymentChoiceOperations: [],
    ...overrides,
  };
}

function transactionClient() {
  return {
    registrationPaymentChoiceOperation: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    registration: {
      findUnique: vi.fn().mockResolvedValue(promotedRegistration()),
      update: vi.fn().mockResolvedValue({}),
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
  dependencies.authorizeRegistrationAccessToken.mockResolvedValue({
    accessTokenId: "access-1",
    registrationId: "registration-1",
    eventId: "event-1",
    registrationStatus: "SUBMITTED",
  });
});

describe("promoted waitlist payment-choice repository", () => {
  it("atomically adds one card gross-up while preserving the discounted base", async () => {
    const tx = transactionClient();
    const prisma = prismaFor(tx);
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await choosePublicPromotedWaitlistPayment(
      "a".repeat(43),
      input,
      { now: new Date("2026-08-12T14:00:00.000Z") },
    );

    expect(result).toMatchObject({
      choice: "CARD",
      baseSubtotalCents: 8_000,
      processingFeeCents: 270,
      totalCents: 8_270,
      currency: "USD",
    });
    expect(tx.registration.update).toHaveBeenCalledWith({
      where: { id: "registration-1" },
      data: { totalAmount: "82.70" },
    });
    expect(tx.registrationPaymentChoiceOperation.create)
      .toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventId: "event-1",
          registrationId: "registration-1",
          sequence: 1,
          clientRequestId: input.clientRequestId,
          expectedPriorOperationId: null,
          choice: "CARD",
          baseSubtotalCents: 8_000,
          processingFeeCents: 270,
          resultingTotalCents: 8_270,
          responseSnapshot: expect.objectContaining({
            totalCents: 8_270,
          }),
        }),
      });
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: "Serializable" },
    );
  });

  it("replays the exact stored response without another total or audit write", async () => {
    const tx = transactionClient();
    const stored = {
      operationId: "04a18ff0-a05a-487a-9e1b-8bd7d01adb05",
      choice: "CARD" as const,
      baseSubtotalCents: 8_000,
      processingFeeCents: 270,
      totalCents: 8_270,
      currency: "USD" as const,
    };
    tx.registrationPaymentChoiceOperation.findUnique.mockResolvedValue({
      requestFingerprint: paymentChoiceRequestFingerprint(
        "registration-1",
        input,
      ),
      responseSnapshot: stored,
    });
    dependencies.getPrisma.mockReturnValue(prismaFor(tx));

    await expect(choosePublicPromotedWaitlistPayment(
      "a".repeat(43),
      input,
    )).resolves.toEqual(stored);
    expect(tx.registration.findUnique).not.toHaveBeenCalled();
    expect(tx.registration.update).not.toHaveBeenCalled();
    expect(tx.registrationPaymentChoiceOperation.create)
      .not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects reuse of a request ID for different choice data", async () => {
    const tx = transactionClient();
    tx.registrationPaymentChoiceOperation.findUnique.mockResolvedValue({
      requestFingerprint: "different-request-fingerprint",
      responseSnapshot: {
        operationId: "04a18ff0-a05a-487a-9e1b-8bd7d01adb05",
        choice: "PAY_LATER",
        baseSubtotalCents: 8_000,
        processingFeeCents: 0,
        totalCents: 8_000,
        currency: "USD",
      },
    });
    dependencies.getPrisma.mockReturnValue(prismaFor(tx));

    await expect(choosePublicPromotedWaitlistPayment(
      "a".repeat(43),
      input,
    )).rejects.toMatchObject({
      code: "PAYMENT_CHOICE_IDEMPOTENCY_CONFLICT",
    });
    expect(tx.registration.findUnique).not.toHaveBeenCalled();
    expect(tx.registration.update).not.toHaveBeenCalled();
  });

  it("rejects stale browser state before changing the total", async () => {
    const tx = transactionClient();
    tx.registration.findUnique.mockResolvedValue(promotedRegistration({
      paymentChoiceOperations: [{
        id: "04a18ff0-a05a-487a-9e1b-8bd7d01adb05",
        sequence: 1,
        choice: "PAY_LATER",
        baseSubtotalCents: 8_000,
        processingFeeCents: 0,
        resultingTotalCents: 8_000,
      }],
    }));
    dependencies.getPrisma.mockReturnValue(prismaFor(tx));

    await expect(choosePublicPromotedWaitlistPayment(
      "a".repeat(43),
      input,
    )).rejects.toMatchObject({
      code: "PAYMENT_CHOICE_CHANGED",
      retryable: false,
    });
    expect(tx.registration.update).not.toHaveBeenCalled();
  });

  it("locks changes once a payment has started", async () => {
    const tx = transactionClient();
    tx.registration.findUnique.mockResolvedValue(promotedRegistration({
      paymentAttempts: [{ id: "attempt-1", status: "PROCESSING" }],
    }));
    dependencies.getPrisma.mockReturnValue(prismaFor(tx));

    await expect(choosePublicPromotedWaitlistPayment(
      "a".repeat(43),
      input,
    )).rejects.toMatchObject({
      code: "PAYMENT_CHOICE_LOCKED",
    });
    expect(tx.registration.update).not.toHaveBeenCalled();
  });
});
