import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => {
  class MockPublicPromoCodeError extends Error {
    constructor(
      public readonly reason: string,
      message: string,
      public readonly fieldId: string | null = null,
    ) {
      super(message);
      this.name = "PublicPromoCodeError";
    }
  }
  return {
    createPromoCode: vi.fn(),
    updatePromoCode: vi.fn(),
    listPromoCodes: vi.fn(),
    getPublicPromoCodeQuote: vi.fn(),
    PublicPromoCodeError: MockPublicPromoCodeError,
    requirePermission: vi.fn(),
    getCurrentSession: vi.fn(),
    findActiveMembership: vi.fn(),
    checkPublicPromoQuoteRateLimit: vi.fn(),
  };
});

vi.mock("@/modules/access/authorization", () => ({
  requirePermission: dependencies.requirePermission,
  AccessDeniedError: class AccessDeniedError extends Error {},
}));
vi.mock("@/modules/access/current-session", () => ({
  getCurrentSession: dependencies.getCurrentSession,
}));
vi.mock("@/modules/events/repository", () => ({
  findActiveMembership: dependencies.findActiveMembership,
}));
vi.mock("@/modules/promo-codes/repository", () => ({
  createPromoCode: dependencies.createPromoCode,
  updatePromoCode: dependencies.updatePromoCode,
  listPromoCodes: dependencies.listPromoCodes,
  getPublicPromoCodeQuote: dependencies.getPublicPromoCodeQuote,
  PublicPromoCodeError: dependencies.PublicPromoCodeError,
  PromoCodeOperationError: class PromoCodeOperationError extends Error {},
}));
vi.mock("@/modules/rate-limit/service", () => ({
  checkPublicPromoQuoteRateLimit:
    dependencies.checkPublicPromoQuoteRateLimit,
}));

import {
  GET as GET_PROMOS,
  POST as CREATE_PROMO,
} from "@/app/api/events/[eventId]/promo-codes/route";
import { PATCH as UPDATE_PROMO } from "@/app/api/events/[eventId]/promo-codes/[promoCodeId]/route";
import { POST as QUOTE_PROMO } from "@/app/api/public/events/[eventSlug]/forms/[formSlug]/promo-code/route";

const staffContext = { params: Promise.resolve({ eventId: "event_1" }) };
const updateContext = {
  params: Promise.resolve({
    eventId: "event_1",
    promoCodeId: "promo_1",
  }),
};
const publicContext = {
  params: Promise.resolve({
    eventSlug: "retreat",
    formSlug: "registration",
  }),
};

function staffRequest(
  path: string,
  method: "GET" | "POST" | "PATCH",
  body?: unknown,
  origin = "https://events.imsda.test",
) {
  return new Request(`https://events.imsda.test${path}`, {
    method,
    headers: {
      origin,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const promoInput = {
  code: " retreat25 ",
  isActive: true,
  discountType: "PERCENT_BPS",
  discountValue: 2500,
  startsOn: null,
  endsOn: "2026-09-01",
  minimumSubtotalCents: 10000,
  maximumUses: 20,
  maximumDiscountCents: 5000,
};

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getCurrentSession.mockResolvedValue({
    user: { id: "user_1" },
  });
  dependencies.requirePermission.mockResolvedValue({
    user: { id: "user_1" },
  });
  dependencies.checkPublicPromoQuoteRateLimit.mockResolvedValue({
    allowed: true,
    decisions: [{
      policy: "public.promo-quote.client-form",
      allowed: true,
      limit: 15,
      remaining: 14,
      count: 1,
      windowSeconds: 900,
      resetAfterSeconds: 400,
    }],
  });
});

describe("staff promo-code routes", () => {
  it("requires same-origin requests even when listing codes", async () => {
    const response = await GET_PROMOS(
      staffRequest(
        "/api/events/event_1/promo-codes",
        "GET",
        undefined,
        "https://untrusted.example",
      ),
      staffContext,
    );
    expect(response.status).toBe(403);
    expect(dependencies.requirePermission).not.toHaveBeenCalled();
  });

  it("requires finance permission and normalizes create input", async () => {
    dependencies.createPromoCode.mockResolvedValue([{ id: "promo_1" }]);
    const response = await CREATE_PROMO(
      staffRequest(
        "/api/events/event_1/promo-codes",
        "POST",
        promoInput,
      ),
      staffContext,
    );
    expect(response.status).toBe(201);
    expect(dependencies.requirePermission).toHaveBeenCalledWith(
      expect.anything(),
      "event_1",
      "MANAGE_FINANCE",
      dependencies.findActiveMembership,
    );
    expect(dependencies.createPromoCode).toHaveBeenCalledWith(
      "event_1",
      expect.objectContaining({ code: "RETREAT25" }),
      "user_1",
    );
  });

  it("passes an optimistic timestamp when updating or deactivating", async () => {
    dependencies.updatePromoCode.mockResolvedValue([{ id: "promo_1" }]);
    const response = await UPDATE_PROMO(
      staffRequest(
        "/api/events/event_1/promo-codes/promo_1",
        "PATCH",
        {
          ...promoInput,
          isActive: false,
          expectedUpdatedAt: "2026-07-23T12:00:00.000Z",
        },
      ),
      updateContext,
    );
    expect(response.status).toBe(200);
    expect(dependencies.updatePromoCode).toHaveBeenCalledWith(
      "event_1",
      "promo_1",
      expect.objectContaining({
        isActive: false,
        expectedUpdatedAt: "2026-07-23T12:00:00.000Z",
      }),
      "user_1",
    );
  });
});

describe("public promo-code quote route", () => {
  function quoteRequest(origin = "https://events.imsda.test") {
    return staffRequest(
      "/api/public/events/retreat/forms/registration/promo-code",
      "POST",
      {
        versionId: "version_1",
        code: "RETREAT25",
        responses: {},
      },
      origin,
    );
  }

  it("returns a no-store, rate-limited server quote", async () => {
    dependencies.getPublicPromoCodeQuote.mockResolvedValue({
      promoCode: "RETREAT25",
      preDiscountSubtotalCents: 10_000,
      discountAmountCents: 2_500,
      subtotalCents: 7_500,
      processingFeeCents: 255,
      totalCents: 7_755,
      lineItems: [],
    });
    const response = await QUOTE_PROMO(quoteRequest(), publicContext);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("ratelimit-remaining")).toBe("14");
    expect(await response.json()).toMatchObject({
      quote: {
        discountAmountCents: 2_500,
        totalCents: 7_755,
      },
    });
  });

  it("attaches an invalid code to the public promo field", async () => {
    dependencies.getPublicPromoCodeQuote.mockRejectedValue(
      new dependencies.PublicPromoCodeError(
        "USE_LIMIT_REACHED",
        "That promo code has reached its use limit.",
        "promo_field",
      ),
    );
    const response = await QUOTE_PROMO(quoteRequest(), publicContext);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: "USE_LIMIT_REACHED",
      issue: {
        key: "promo_code",
        fieldId: "promo_field",
        message: "That promo code has reached its use limit.",
      },
    });
  });

  it("rejects cross-origin and exhausted quote requests before repository access", async () => {
    const crossOrigin = await QUOTE_PROMO(
      quoteRequest("https://untrusted.example"),
      publicContext,
    );
    expect(crossOrigin.status).toBe(403);
    expect(dependencies.getPublicPromoCodeQuote).not.toHaveBeenCalled();

    dependencies.checkPublicPromoQuoteRateLimit.mockResolvedValue({
      allowed: false,
      decisions: [{
        policy: "public.promo-quote.client-form",
        allowed: false,
        limit: 15,
        remaining: 0,
        count: 16,
        windowSeconds: 900,
        resetAfterSeconds: 300,
      }],
    });
    const exhausted = await QUOTE_PROMO(quoteRequest(), publicContext);
    expect(exhausted.status).toBe(429);
    expect(exhausted.headers.get("retry-after")).toBe("300");
    expect(dependencies.getPublicPromoCodeQuote).not.toHaveBeenCalled();
  });
});

