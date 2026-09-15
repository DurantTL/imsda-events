import { describe, expect, it } from "vitest";
import {
  assertMerchandiseInventoryAvailable,
  buildMerchandiseQuoteDraft,
  merchandiseQuoteRequestSchema,
  replayMerchandiseQuote,
  type MerchandiseQuoteCatalog,
  type MerchandiseQuoteRequest,
} from "@/modules/merchandise/quote-domain";

const now = new Date("2026-09-14T15:00:00.000Z");

function catalog(): MerchandiseQuoteCatalog {
  return {
    id: "catalog-1",
    eventId: "event-1",
    eventIsPublished: true,
    isEnabled: true,
    status: "APPROVED",
    taxRateBasisPoints: 825,
    cardFeePercentageBasisPoints: 290,
    cardFeeFixedCents: 30,
    quoteTtlMinutes: 15,
    products: [{
      id: "product-1",
      name: "Synthetic retreat shirt",
      isEnabled: true,
      isArchived: false,
      variants: [{
        id: "variant-1",
        label: "Medium",
        isEnabled: true,
        isArchived: false,
        availability: {
          id: "availability-1",
          versionNumber: 1,
          priceCents: 2_500,
          taxTreatment: "TAXABLE",
          feePolicy: "PASSED_TO_BUYER",
          inventoryPolicy: "TRACKED",
          inventoryQuantity: 3,
          salesStartsAt: new Date("2026-09-01T00:00:00.000Z"),
          salesEndsAt: new Date("2026-09-30T23:59:59.000Z"),
          minQuantity: 1,
          maxQuantity: 3,
          attendeeAvailability: "ALL",
          isActive: true,
        },
      }, {
        id: "variant-2",
        label: "Mug",
        isEnabled: true,
        isArchived: false,
        availability: {
          id: "availability-2",
          versionNumber: 1,
          priceCents: 1_000,
          taxTreatment: "TAX_EXEMPT",
          feePolicy: "ABSORBED_BY_EVENT",
          inventoryPolicy: "UNLIMITED",
          inventoryQuantity: null,
          salesStartsAt: null,
          salesEndsAt: null,
          minQuantity: 1,
          maxQuantity: null,
          attendeeAvailability: "REGISTERED",
          isActive: true,
        },
      }],
    }],
  };
}

function request(paymentMethod: "CARD" | "CASH" | "CHECK" = "CARD"): MerchandiseQuoteRequest {
  return {
    clientRequestId: "quote-request-1",
    paymentMethod,
    lines: [
      { variantId: "variant-1", quantity: 2 },
      { variantId: "variant-2", quantity: 1 },
    ],
  };
}

function build(
  paymentMethod: "CARD" | "CASH" | "CHECK" = "CARD",
  source = catalog(),
) {
  return buildMerchandiseQuoteDraft({
    eventId: "event-1",
    request: request(paymentMethod),
    identity: { registrationId: "registration-1" },
    eligibility: "REGISTERED",
    catalog: source,
    now,
  });
}

describe("authoritative merchandise quote pricing", () => {
  it("derives tax and the incremental card fee only from persisted selected terms", () => {
    const quote = build();

    expect(quote).toMatchObject({
      subtotalCents: 6_000,
      taxCents: 413,
      feeCents: 193,
      totalCents: 6_606,
      expiresAt: new Date("2026-09-14T15:15:00.000Z"),
    });
    expect(quote.lines).toEqual([
      expect.objectContaining({
        availabilityId: "availability-1",
        unitPriceCentsSnapshot: 2_500,
        quantity: 2,
        lineSubtotalCents: 5_000,
        lineTaxCents: 413,
      }),
      expect.objectContaining({
        availabilityId: "availability-2",
        unitPriceCentsSnapshot: 1_000,
        quantity: 1,
        lineSubtotalCents: 1_000,
        lineTaxCents: 0,
      }),
    ]);
  });

  it.each(["CASH", "CHECK"] as const)("adds no card fee to a %s quote", (method) => {
    expect(build(method)).toMatchObject({ feeCents: 0, totalCents: 6_413 });
  });

  it("rejects browser totals and duplicate variant submissions", () => {
    expect(merchandiseQuoteRequestSchema.safeParse({
      ...request(),
      totalCents: 1,
    }).success).toBe(false);
    expect(merchandiseQuoteRequestSchema.safeParse({
      ...request(),
      lines: [
        { variantId: "variant-1", quantity: 1 },
        { variantId: "variant-1", quantity: 1 },
      ],
    }).success).toBe(false);
  });
});

describe("merchandise quote catalog enforcement", () => {
  it("rejects disabled variants and expired sales windows", () => {
    const disabled = catalog();
    disabled.products[0]!.variants[0]!.isEnabled = false;
    expect(() => build("CARD", disabled)).toThrowError(expect.objectContaining({
      code: "VARIANT_UNAVAILABLE",
    }));

    const expired = catalog();
    expired.products[0]!.variants[0]!.availability!.salesEndsAt =
      new Date("2026-09-14T14:59:59.999Z");
    expect(() => build("CARD", expired)).toThrowError(expect.objectContaining({
      code: "VARIANT_UNAVAILABLE",
    }));
  });

  it("enforces eligibility and configured quantity limits", () => {
    expect(() => buildMerchandiseQuoteDraft({
      eventId: "event-1",
      request: request(),
      identity: {},
      eligibility: "PUBLIC",
      catalog: catalog(),
      now,
    })).toThrowError(expect.objectContaining({ code: "ELIGIBILITY_REQUIRED" }));

    const tooMany = request();
    tooMany.lines[0]!.quantity = 4;
    expect(() => buildMerchandiseQuoteDraft({
      eventId: "event-1",
      request: tooMany,
      identity: { registrationId: "registration-1" },
      eligibility: "REGISTERED",
      catalog: catalog(),
      now,
    })).toThrowError(expect.objectContaining({ code: "QUANTITY_NOT_ALLOWED" }));
  });

  it("fingerprints price and sales-window changes even when totals are unchanged", () => {
    const original = build();
    const changedPrice = catalog();
    changedPrice.products[0]!.variants[0]!.availability!.priceCents = 2_501;
    expect(build("CARD", changedPrice).catalogFingerprint)
      .not.toBe(original.catalogFingerprint);

    const changedWindow = catalog();
    changedWindow.products[0]!.variants[0]!.availability!.salesEndsAt =
      new Date("2026-09-29T23:59:59.000Z");
    expect(build("CARD", changedWindow).catalogFingerprint)
      .not.toBe(original.catalogFingerprint);
  });
});

describe("merchandise quote inventory and retries", () => {
  it("rejects a last-item request when another quote already reserves it", () => {
    const quote = build();
    expect(() => assertMerchandiseInventoryAvailable(
      quote,
      new Map([["variant-1", 2]]),
    )).toThrowError(expect.objectContaining({ code: "OUT_OF_STOCK" }));
  });

  it("replays an exact request fingerprint and rejects key reuse", () => {
    const existing = { id: "quote-1", requestFingerprint: build().requestFingerprint };
    expect(replayMerchandiseQuote(existing, build().requestFingerprint)).toBe(existing);
    expect(() => replayMerchandiseQuote(existing, "changed"))
      .toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_KEY_REUSED" }));
  });
});
