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
    createPublicSquarePaymentLink: vi.fn(),
    checkPublicPaymentRateLimit: vi.fn(),
    SquarePaymentOperationError: MockSquarePaymentOperationError,
  };
});

vi.mock("@/lib/request-context", () => ({ withRequestContext: (handler: unknown) => handler }));
vi.mock("@/modules/access/request-security", () => ({
  rejectCrossOriginRequest: mocks.rejectCrossOriginRequest,
}));
vi.mock("@/modules/payments/square-hosted-repository", () => ({
  createPublicSquarePaymentLink: mocks.createPublicSquarePaymentLink,
}));
vi.mock("@/modules/payments/square-repository", () => ({
  SquarePaymentOperationError: mocks.SquarePaymentOperationError,
}));
vi.mock("@/modules/rate-limit/service", () => ({
  checkPublicPaymentRateLimit: mocks.checkPublicPaymentRateLimit,
}));

import { POST } from "@/app/api/public/manage/[token]/payment-link/route";

const token = "a".repeat(43);
const context = { params: Promise.resolve({ token }) };
const idempotencyKey = "d67776d0-f79d-4e8f-bec2-ee61abb7337c";
const returnId = "R".repeat(43);
const body = { idempotencyKey, returnId };
type Handler = (request: Request, context: unknown) => Promise<Response>;
const post = POST as unknown as Handler;

function linkRequest(body: unknown) {
  return new Request(`https://events.imsda.test/api/public/manage/${token}/payment-link`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://events.imsda.test" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const allowed = { allowed: true, decisions: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.checkPublicPaymentRateLimit.mockResolvedValue(allowed);
  mocks.createPublicSquarePaymentLink.mockResolvedValue({
    url: "https://sandbox.square.link/u/synthetic",
    amountCents: 10_330,
    balanceCents: 10_000,
    surchargeCents: 330,
    currency: "USD",
    expiresAt: "2026-10-10T10:00:00.000Z",
  });
});

describe("private Pay on Square link route (#327)", () => {
  it("returns the link with private, no-store headers", async () => {
    const response = await post(linkRequest(body), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.json()).toMatchObject({ link: { url: "https://sandbox.square.link/u/synthetic", amountCents: 10_330 } });
    expect(mocks.createPublicSquarePaymentLink).toHaveBeenCalledWith(token, body);
  });

  it("accepts a request key and nothing else, so the browser can never name an amount", async () => {
    for (const bad of [{ ...body, amountCents: 1 }, { idempotencyKey: "not-a-uuid", returnId }, { idempotencyKey }, {}]) {
      const response = await post(linkRequest(bad), context);
      expect(response.status).toBe(400);
    }
    expect((await post(linkRequest("{not json"), context)).status).toBe(400);
    expect(mocks.createPublicSquarePaymentLink).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin request and a rate-limited one before doing anything", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(Response.json({ error: "INVALID_REQUEST_ORIGIN" }, { status: 403 }));
    const crossOrigin = await post(linkRequest(body), context);
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.headers.get("cache-control")).toContain("no-store");
    mocks.rejectCrossOriginRequest.mockReturnValue(null);
    mocks.checkPublicPaymentRateLimit.mockResolvedValue({ allowed: false, decisions: [] });
    expect((await post(linkRequest(body), context)).status).toBe(429);
    expect(mocks.createPublicSquarePaymentLink).not.toHaveBeenCalled();
  });

  it("answers 404 for a token that opens no registration, whatever registration or event it was meant for", async () => {
    mocks.createPublicSquarePaymentLink.mockRejectedValueOnce(
      new mocks.SquarePaymentOperationError("REGISTRATION_ACCESS_UNAVAILABLE", "This private registration link is invalid or no longer active."),
    );
    const response = await post(linkRequest(body), { params: Promise.resolve({ token: "b".repeat(43) }) });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "REGISTRATION_ACCESS_UNAVAILABLE" });
    expect(mocks.createPublicSquarePaymentLink).toHaveBeenCalledWith("b".repeat(43), body);
  });

  it("maps operation errors to the same statuses the card payment route uses", async () => {
    const cases: Array<[string, number]> = [
      ["REGISTRATION_ACCESS_UNAVAILABLE", 404],
      ["SQUARE_NOT_CONFIGURED", 503],
      ["PAYMENT_RESULT_UNCERTAIN", 503],
      ["PAYMENT_ATTEMPT_FAILED", 422],
      ["PAYMENT_IN_PROGRESS", 409],
      ["PAYMENT_ALREADY_COMPLETE", 409],
      ["PAYMENT_NOT_ELIGIBLE", 409],
    ];
    for (const [code, status] of cases) {
      mocks.createPublicSquarePaymentLink.mockRejectedValueOnce(new mocks.SquarePaymentOperationError(code, "No.", code === "PAYMENT_RESULT_UNCERTAIN"));
      const response = await post(linkRequest(body), context);
      expect(response.status, code).toBe(status);
      expect(await response.json()).toMatchObject({ error: code });
    }
  });
});
