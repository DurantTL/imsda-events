import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockPaymentChoiceOperationError extends Error {
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
    choosePublicPromotedWaitlistPayment: vi.fn(),
    checkPublicManageRateLimit: vi.fn(),
    PaymentChoiceOperationError: MockPaymentChoiceOperationError,
  };
});

vi.mock("@/modules/access/request-security", () => ({
  rejectCrossOriginRequest: mocks.rejectCrossOriginRequest,
}));
vi.mock("@/modules/payments/payment-choice-repository", () => ({
  choosePublicPromotedWaitlistPayment:
    mocks.choosePublicPromotedWaitlistPayment,
  PaymentChoiceOperationError: mocks.PaymentChoiceOperationError,
}));
vi.mock("@/modules/rate-limit/service", () => ({
  checkPublicManageRateLimit: mocks.checkPublicManageRateLimit,
}));

import {
  POST,
} from "@/app/api/public/manage/[token]/payment-choice/route";

const token = "a".repeat(43);
const context = { params: Promise.resolve({ token }) };
const requestBody = {
  choice: "CARD",
  clientRequestId: "19af978c-b75a-4860-9df5-e9110dc2671e",
  expectedPriorOperationId: null,
};

function choiceRequest(body: Record<string, unknown>) {
  return new Request(
    `https://events.imsda.test/api/public/manage/${token}/payment-choice`,
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
      policy: "public.manage.update.client-token",
      allowed,
      limit: 10,
      remaining: allowed ? 9 : 0,
      count: allowed ? 1 : 11,
      windowSeconds: 900,
      resetAfterSeconds: 211,
    }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.checkPublicManageRateLimit.mockResolvedValue(
    rateLimitOutcome(true),
  );
  mocks.choosePublicPromotedWaitlistPayment.mockResolvedValue({
    operationId: "04a18ff0-a05a-487a-9e1b-8bd7d01adb05",
    choice: "CARD",
    baseSubtotalCents: 8_000,
    processingFeeCents: 270,
    totalCents: 8_270,
    currency: "USD",
  });
});

describe("promoted waitlist payment-choice route", () => {
  it("accepts only the explicit choice and optimistic idempotency fields", async () => {
    const response = await POST(choiceRequest(requestBody), context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(mocks.checkPublicManageRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      token,
      "update",
    );
    expect(mocks.choosePublicPromotedWaitlistPayment).toHaveBeenCalledWith(
      token,
      requestBody,
    );
    expect(await response.json()).toMatchObject({
      paymentChoice: {
        choice: "CARD",
        totalCents: 8_270,
      },
    });
  });

  it("rejects a client-supplied amount before the repository", async () => {
    const response = await POST(choiceRequest({
      ...requestBody,
      totalCents: 1,
    }), context);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "INVALID_PAYMENT_CHOICE",
    });
    expect(mocks.choosePublicPromotedWaitlistPayment)
      .not.toHaveBeenCalled();
  });

  it("returns the current operation on a two-window conflict", async () => {
    mocks.choosePublicPromotedWaitlistPayment.mockRejectedValue(
      new mocks.PaymentChoiceOperationError(
        "PAYMENT_CHOICE_CHANGED",
        "Refresh before choosing again.",
        false,
        {
          currentOperationId:
            "04a18ff0-a05a-487a-9e1b-8bd7d01adb05",
        },
      ),
    );

    const response = await POST(choiceRequest(requestBody), context);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "PAYMENT_CHOICE_CHANGED",
      message: "Refresh before choosing again.",
      retryable: false,
      details: {
        currentOperationId:
          "04a18ff0-a05a-487a-9e1b-8bd7d01adb05",
      },
    });
  });

  it("rejects rate-limited or cross-origin mutations before saving", async () => {
    mocks.checkPublicManageRateLimit.mockResolvedValue(
      rateLimitOutcome(false),
    );
    const limited = await POST(choiceRequest(requestBody), context);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("211");
    expect(mocks.choosePublicPromotedWaitlistPayment)
      .not.toHaveBeenCalled();

    mocks.rejectCrossOriginRequest.mockReturnValue(
      Response.json({ error: "INVALID_REQUEST_ORIGIN" }, { status: 403 }),
    );
    const crossOrigin = await POST(choiceRequest(requestBody), context);
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
  });
});
