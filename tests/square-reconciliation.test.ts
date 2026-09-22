import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { SquareRuntimeConfiguration } from "@/modules/payments/square-config-domain";
import {
  collectSquareReconciliationReport,
  isActionable,
} from "@/modules/payments/square-reconciliation";

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

function squarePayment(overrides: Record<string, unknown> = {}) {
  return {
    id: "square-payment-ext-1",
    status: "COMPLETED",
    amount_money: { amount: 8_000, currency: "USD" },
    location_id: "main-location",
    note: "Womens Retreat balance WR26-4417",
    created_at: "2026-07-23T13:59:00.000Z",
    ...overrides,
  };
}

function squareListing(payments: Array<Record<string, unknown>>, cursor?: string) {
  return vi.fn().mockResolvedValue(
    Response.json({ payments, ...(cursor ? { cursor } : {}) }),
  );
}

function prismaStub(overrides: Record<string, unknown> = {}) {
  return {
    payment: { findFirst: vi.fn().mockResolvedValue(null) },
    paymentAttempt: { findFirst: vi.fn().mockResolvedValue(null) },
    registration: {
      findMany: vi.fn().mockResolvedValue([{
        confirmationCode: "WR26-4417",
        totalAmount: 80,
        payments: [],
      }]),
    },
    squareWebhookEvent: { findMany: vi.fn().mockResolvedValue([]) },
    ...overrides,
  };
}

const window = { beginTime: "2026-07-01T00:00:00.000Z" };

async function report(
  prisma: ReturnType<typeof prismaStub>,
  fetcher: ReturnType<typeof squareListing>,
) {
  return collectSquareReconciliationReport(
    prisma as never,
    configuration,
    window,
    fetcher,
  );
}

describe("Square reconciliation report", () => {
  it("flags a completed Square payment this database never recorded", async () => {
    const result = await report(prismaStub(), squareListing([squarePayment()]));

    expect(result.examined).toBe(1);
    expect(result.findings[0]).toMatchObject({
      code: "APPLICABLE",
      providerPaymentId: "square-payment-ext-1",
      confirmationCode: "WR26-4417",
      amountCents: 8_000,
      balanceCents: 8_000,
    });
    expect(result.findings.filter(isActionable)).toHaveLength(1);
  });

  it("says nothing is wrong when the payment is already recorded", async () => {
    const prisma = prismaStub({
      payment: {
        findFirst: vi.fn().mockResolvedValue({
          id: "payment-9",
          registration: { confirmationCode: "WR26-4417" },
        }),
      },
    });

    const result = await report(prisma, squareListing([squarePayment()]));

    expect(result.findings[0]!.code).toBe("RECORDED");
    expect(result.findings.filter(isActionable)).toHaveLength(0);
  });

  it("counts a payment an attempt is still tracking as recorded", async () => {
    const prisma = prismaStub({
      paymentAttempt: {
        findFirst: vi.fn().mockResolvedValue({
          status: "PENDING",
          registration: { confirmationCode: "WR26-4417" },
        }),
      },
    });

    const result = await report(prisma, squareListing([squarePayment()]));

    expect(result.findings[0]).toMatchObject({
      code: "RECORDED",
      detail: expect.stringContaining("PENDING"),
    });
  });

  it.each([
    ["NO_CONFIRMATION_CODE", { note: "Retreat balance" }, prismaStub()],
    [
      "NO_REGISTRATION",
      {},
      prismaStub({ registration: { findMany: vi.fn().mockResolvedValue([]) } }),
    ],
    [
      "AMBIGUOUS_REGISTRATION",
      {},
      prismaStub({
        registration: {
          findMany: vi.fn().mockResolvedValue([
            { confirmationCode: "WR26-4417", totalAmount: 80, payments: [] },
            { confirmationCode: "WR26-4417", totalAmount: 95, payments: [] },
          ]),
        },
      }),
    ],
    ["AMOUNT_MISMATCH", { amount_money: { amount: 7_500, currency: "USD" } }, prismaStub()],
    ["OTHER_LOCATION", { location_id: "elsewhere" }, prismaStub()],
  ])("classifies an unrecorded payment as %s", async (code, overrides, prisma) => {
    const result = await report(
      prisma,
      squareListing([squarePayment(overrides)]),
    );

    expect(result.findings[0]!.code).toBe(code);
  });

  it("skips payments Square did not complete", async () => {
    const result = await report(
      prismaStub(),
      squareListing([squarePayment({ status: "FAILED" })]),
    );

    expect(result.examined).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("follows Square's cursor across pages", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({
        payments: [squarePayment()],
        cursor: "page-2",
      }))
      .mockResolvedValueOnce(Response.json({
        payments: [squarePayment({ id: "square-payment-ext-2" })],
      }));

    const result = await report(prismaStub(), fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]![0])).toContain("cursor=page-2");
    expect(result.examined).toBe(2);
  });

  it("still reports declined webhook deliveries when Square cannot be reached", async () => {
    const prisma = prismaStub({
      squareWebhookEvent: {
        findMany: vi.fn().mockResolvedValue([{
          eventType: "payment.updated",
          objectId: "square-payment-ext-1",
          reason: "No IMSDA Square payment attempt matches this provider payment.",
          occurredAt: new Date("2026-07-23T14:00:00.000Z"),
        }]),
      },
    });

    const result = await report(prisma, vi.fn().mockRejectedValue(new Error("offline")));

    expect(result.unreachableSquare).toBe(true);
    expect(result.ignoredWebhookEvents).toHaveLength(1);
  });

  it("asks Square only for the configured location and window", async () => {
    const fetcher = squareListing([]);

    await report(prismaStub(), fetcher);

    const url = String(fetcher.mock.calls[0]![0]);
    expect(url).toContain("location_id=main-location");
    expect(url).toContain("begin_time=2026-07-01");
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: "GET" });
  });
});
