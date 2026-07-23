import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockSquarePaymentOperationError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly retryable = false,
      public readonly details: Record<string, unknown> = {},
    ) {
      super(message);
    }
  }
  return {
    rejectCrossOriginRequest: vi.fn(),
    getPublicSquareCheckout: vi.fn(),
    createPublicSquarePayment: vi.fn(),
    checkPublicPaymentRateLimit: vi.fn(),
    SquarePaymentOperationError: MockSquarePaymentOperationError,
  };
});

vi.mock("@/modules/access/request-security", () => ({
  rejectCrossOriginRequest: mocks.rejectCrossOriginRequest,
}));
vi.mock("@/modules/payments/square-repository", () => ({
  getPublicSquareCheckout: mocks.getPublicSquareCheckout,
  createPublicSquarePayment: mocks.createPublicSquarePayment,
  SquarePaymentOperationError: mocks.SquarePaymentOperationError,
}));
vi.mock("@/modules/rate-limit/service", () => ({
  checkPublicPaymentRateLimit: mocks.checkPublicPaymentRateLimit,
}));

import {
  GET,
  POST,
} from "@/app/api/public/manage/[token]/payment/route";

const token = "a".repeat(43);
const context = { params: Promise.resolve({ token }) };
const idempotencyKey = "d67776d0-f79d-4e8f-bec2-ee61abb7337c";

function paymentRequest(body: Record<string, unknown>) {
  return new Request(
    `https://events.imsda.test/api/public/manage/${token}/payment`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://events.imsda.test",
      },
      body: JSON.stringify(body),
    },
  );
}

function rateLimitOutcome(allowed: boolean) {
  return {
    allowed,
    decisions: [{
      policy: "public.payment.client-token",
      allowed,
      limit: 5,
      remaining: allowed ? 4 : 0,
      count: allowed ? 1 : 6,
      windowSeconds: 900,
      resetAfterSeconds: 287,
    }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.getPublicSquareCheckout.mockResolvedValue({
    state: "READY",
    amountCents: 12_930,
  });
  mocks.createPublicSquarePayment.mockResolvedValue({
    status: "SUCCEEDED",
    amountCents: 12_930,
    currency: "USD",
    message: "Square confirmed the card payment.",
  });
  mocks.checkPublicPaymentRateLimit.mockResolvedValue(rateLimitOutcome(true));
});

describe("private Square payment route", () => {
  it("returns a no-store server quote without exposing provider secrets", async () => {
    const response = await GET(
      new Request(
        `https://events.imsda.test/api/public/manage/${token}/payment`,
      ),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(mocks.getPublicSquareCheckout).toHaveBeenCalledWith(token);
    const body = await response.json();
    expect(body.checkout.amountCents).toBe(12_930);
    expect(JSON.stringify(body)).not.toContain("accessToken");
  });

  it("accepts only a Square source token and client idempotency key", async () => {
    const response = await POST(paymentRequest({
      sourceId: "cnon:card-nonce-ok",
      idempotencyKey,
    }), context);

    expect(response.status).toBe(200);
    expect(mocks.createPublicSquarePayment).toHaveBeenCalledWith(token, {
      sourceId: "cnon:card-nonce-ok",
      idempotencyKey,
    });
  });

  it("rejects a client-supplied amount before the domain operation", async () => {
    const response = await POST(paymentRequest({
      sourceId: "cnon:card-nonce-ok",
      idempotencyKey,
      amountCents: 1,
    }), context);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "INVALID_PAYMENT_REQUEST",
    });
    expect(mocks.createPublicSquarePayment).not.toHaveBeenCalled();
  });

  it("returns a retry-safe uncertain result without logging card data", async () => {
    mocks.createPublicSquarePayment.mockRejectedValue(
      new mocks.SquarePaymentOperationError(
        "PAYMENT_RESULT_UNCERTAIN",
        "Square did not confirm the payment request. It is safe to retry.",
        true,
      ),
    );

    const response = await POST(paymentRequest({
      sourceId: "cnon:card-nonce-ok",
      idempotencyKey,
    }), context);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "PAYMENT_RESULT_UNCERTAIN",
      message: "Square did not confirm the payment request. It is safe to retry.",
      retryable: true,
      details: {},
    });
  });

  it("rejects an exhausted client-token bucket before parsing or charging", async () => {
    mocks.checkPublicPaymentRateLimit.mockResolvedValue(
      rateLimitOutcome(false),
    );

    const response = await POST(paymentRequest({
      sourceId: "cnon:card-nonce-ok",
      idempotencyKey,
    }), context);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("287");
    expect(response.headers.get("ratelimit-remaining")).toBe("0");
    expect(mocks.checkPublicPaymentRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      token,
    );
    expect(mocks.createPublicSquarePayment).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ error: "RATE_LIMITED" });
  });
});
