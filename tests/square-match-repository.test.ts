import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  getSquarePayment: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/payments/square-http", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("@/modules/payments/square-http")
  >();
  return { ...original, getSquarePayment: dependencies.getSquarePayment };
});

import type { SquareRuntimeConfiguration } from "@/modules/payments/square-config";
import {
  attachSquarePaymentToRegistration,
  SquareMatchOperationError,
} from "@/modules/payments/square-match-repository";

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

function providerPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: "square-payment-ext-1",
    status: "COMPLETED",
    amountCents: 14_951,
    currency: "USD",
    note: "Women's Retreat 2026",
    referenceId: "4632",
    locationId: "main-location",
    createdAt: "2026-09-15T16:42:31.463Z",
    ...overrides,
  };
}

/** Owes $145.00, nothing paid — the shape behind every AMOUNT_MISMATCH. */
function registration(overrides: Record<string, unknown> = {}) {
  return {
    id: "registration-9",
    confirmationCode: "WR26-1789248881256-0645",
    status: "CONFIRMED",
    totalAmount: 145,
    payments: [],
    ...overrides,
  };
}

function transactionClient() {
  return {
    payment: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "payment-9" }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
}

function prismaFor(
  tx: ReturnType<typeof transactionClient>,
  found: unknown = registration(),
) {
  return {
    registration: { findFirst: vi.fn().mockResolvedValue(found) },
    $transaction: vi.fn(async (
      operation: (client: typeof tx) => unknown,
    ) => operation(tx)),
  };
}

function attach() {
  return attachSquarePaymentToRegistration(
    "event-1",
    "registration-9",
    "user-1",
    { providerPaymentId: "square-payment-ext-1" },
    { configuration },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getSquarePayment.mockResolvedValue(providerPayment());
});

describe("attaching a Square payment by hand", () => {
  it("records what Square actually took, not what the caller claims", async () => {
    const tx = transactionClient();
    dependencies.getPrisma.mockReturnValue(prismaFor(tx));

    const result = await attach();

    expect(tx.payment.create).toHaveBeenCalledWith({
      data: {
        eventId: "event-1",
        registrationId: "registration-9",
        amount: 149.51,
        status: "SUCCEEDED",
        method: "CARD_REFERENCE",
        externalReference: "square-payment-ext-1",
        receivedAt: new Date("2026-09-15T16:42:31.463Z"),
      },
    });
    expect(result).toMatchObject({
      amountCents: 14_951,
      balanceBeforeCents: 14_500,
      overpaidCents: 451,
      confirmationCode: "WR26-1789248881256-0645",
    });
  });

  it("writes an attributable audit record naming the staff member", async () => {
    const tx = transactionClient();
    dependencies.getPrisma.mockReturnValue(prismaFor(tx));

    await attach();

    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "SQUARE_PAYMENT_MANUALLY_MATCHED",
        actorUserId: "user-1",
        metadata: expect.objectContaining({
          providerPaymentId: "square-payment-ext-1",
          amountCents: 14_951,
          overpaidCents: 451,
        }),
      }),
    }));
  });

  it("re-reads the amount from Square rather than trusting the request", async () => {
    const tx = transactionClient();
    dependencies.getPrisma.mockReturnValue(prismaFor(tx));
    dependencies.getSquarePayment.mockResolvedValue(
      providerPayment({ amountCents: 100 }),
    );

    const result = await attach();

    expect(result.amountCents).toBe(100);
    expect(tx.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: 1 }) }),
    );
  });

  it.each([
    ["PROVIDER_PAYMENT_NOT_FOUND", null],
    ["PROVIDER_PAYMENT_NOT_COMPLETED", providerPayment({ status: "FAILED" })],
    ["PROVIDER_PAYMENT_WRONG_LOCATION", providerPayment({ locationId: "elsewhere" })],
  ])("refuses with %s", async (code, provider) => {
    const tx = transactionClient();
    dependencies.getPrisma.mockReturnValue(prismaFor(tx));
    dependencies.getSquarePayment.mockResolvedValue(provider);

    await expect(attach()).rejects.toMatchObject({ code });
    expect(tx.payment.create).not.toHaveBeenCalled();
  });

  it("refuses to record the same Square payment twice", async () => {
    const tx = transactionClient();
    tx.payment.findFirst.mockResolvedValue({ id: "payment-existing" });
    dependencies.getPrisma.mockReturnValue(prismaFor(tx));

    await expect(attach()).rejects.toMatchObject({
      code: "PAYMENT_ALREADY_RECORDED",
    });
    expect(tx.payment.create).not.toHaveBeenCalled();
  });

  // The WR26 import copied an unverified "Square Payment ID" column out of the
  // source spreadsheet, so the same real payment can already be recorded under
  // a reference Square would not recognise. Deduplicating on the provider id
  // alone cannot see it.
  it("refuses when the registration already has a payment for the same amount", async () => {
    const tx = transactionClient();
    dependencies.getPrisma.mockReturnValue(prismaFor(tx, registration({
      payments: [{
        id: "payment-imported",
        amount: 149.51,
        externalReference: "sheet-supplied-id",
        refunds: [],
      }],
    })));

    await expect(attach()).rejects.toMatchObject({
      code: "PAYMENT_LIKELY_DUPLICATE",
    });
    expect(tx.payment.create).not.toHaveBeenCalled();
  });

  it("proceeds once a human confirms it is genuinely a second payment", async () => {
    const tx = transactionClient();
    dependencies.getPrisma.mockReturnValue(prismaFor(tx, registration({
      payments: [{
        id: "payment-imported",
        amount: 149.51,
        externalReference: "sheet-supplied-id",
        refunds: [],
      }],
    })));

    await attachSquarePaymentToRegistration(
      "event-1",
      "registration-9",
      "user-1",
      {
        providerPaymentId: "square-payment-ext-1",
        acknowledgeDuplicate: true,
      },
      { configuration },
    );

    expect(tx.payment.create).toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        metadata: expect.objectContaining({
          acknowledgedDuplicateOf: "payment-imported",
        }),
      }),
    }));
  });

  it("allows a different amount through without a duplicate confirmation", async () => {
    const tx = transactionClient();
    dependencies.getPrisma.mockReturnValue(prismaFor(tx, registration({
      payments: [{
        id: "payment-imported",
        amount: 45,
        externalReference: "sheet-supplied-id",
        refunds: [],
      }],
    })));

    await attach();

    expect(tx.payment.create).toHaveBeenCalled();
  });

  it("refuses a registration outside the event", async () => {
    const tx = transactionClient();
    dependencies.getPrisma.mockReturnValue(prismaFor(tx, null));

    await expect(attach()).rejects.toMatchObject({
      code: "REGISTRATION_NOT_FOUND",
    });
  });

  it("refuses a cancelled registration", async () => {
    const tx = transactionClient();
    dependencies.getPrisma.mockReturnValue(
      prismaFor(tx, registration({ status: "CANCELLED" })),
    );

    await expect(attach()).rejects.toMatchObject({
      code: "REGISTRATION_NOT_PAYABLE",
    });
    expect(tx.payment.create).not.toHaveBeenCalled();
  });

  it("reports Square being unreachable rather than recording a guess", async () => {
    const tx = transactionClient();
    dependencies.getPrisma.mockReturnValue(prismaFor(tx));
    dependencies.getSquarePayment.mockRejectedValue(new Error("offline"));

    await expect(attach()).rejects.toBeInstanceOf(SquareMatchOperationError);
    expect(tx.payment.create).not.toHaveBeenCalled();
  });

  it("subtracts prior payments when reporting the balance it settled", async () => {
    const tx = transactionClient();
    dependencies.getPrisma.mockReturnValue(prismaFor(tx, registration({
      payments: [{ amount: 45, refunds: [] }],
    })));

    const result = await attach();

    expect(result.balanceBeforeCents).toBe(10_000);
    expect(result.overpaidCents).toBe(4_951);
  });
});
