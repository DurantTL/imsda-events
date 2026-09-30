import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockAccessDeniedError extends Error {
    constructor(message: string, public readonly status = 403, public readonly code = "PERMISSION_DENIED") {
      super(message);
    }
  }
  class MockPaymentOperationError extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  }
  return {
    AccessDeniedError: MockAccessDeniedError,
    PaymentOperationError: MockPaymentOperationError,
    requirePermission: vi.fn(),
    getCurrentSession: vi.fn(),
    rejectCrossOriginRequest: vi.fn(),
    findActiveMembership: vi.fn(),
    recordRefund: vi.fn(),
  };
});

vi.mock("@/modules/access/authorization", () => ({
  AccessDeniedError: mocks.AccessDeniedError,
  requirePermission: mocks.requirePermission,
}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: mocks.findActiveMembership }));
vi.mock("@/modules/payments/repository", () => ({
  PaymentOperationError: mocks.PaymentOperationError,
  recordRefund: mocks.recordRefund,
}));

import { POST } from "@/app/api/events/[eventId]/payments/[paymentId]/refunds/route";

const context = { params: Promise.resolve({ eventId: "event-1", paymentId: "payment-1" }) };
const body = { amountCents: 1000, reason: "Registrant request", idempotencyKey: "key-operation-1" };

function request(payload: unknown) {
  return new Request("https://events.imsda.test/api/events/event-1/payments/payment-1/refunds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.requirePermission.mockResolvedValue({ user: { id: "user-1" } });
});

describe("manual refund route", () => {
  it("rejects a missing idempotency key with 400", async () => {
    const response = await POST(request({ amountCents: 1000, reason: "Registrant request" }), context);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("INVALID_REFUND");
    expect(mocks.recordRefund).not.toHaveBeenCalled();
  });

  it("answers the original and a replayed request with 201 and the same body", async () => {
    mocks.recordRefund.mockResolvedValue({ id: "registration-1" });
    const first = await POST(request(body), context);
    const replay = await POST(request(body), context);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(await first.json());
    expect(mocks.recordRefund).toHaveBeenCalledWith("event-1", "payment-1", "user-1", body);
  });

  it("maps a reused key with different details to 409", async () => {
    mocks.recordRefund.mockRejectedValue(new mocks.PaymentOperationError("REFUND_IDEMPOTENCY_KEY_REUSED"));
    const response = await POST(request(body), context);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("REFUND_IDEMPOTENCY_KEY_REUSED");
  });
});
