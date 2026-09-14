import { createHash } from "node:crypto";
import { z } from "zod";

export const merchandiseQuotePaymentMethods = ["CARD", "CASH", "CHECK"] as const;
export type MerchandiseQuotePaymentMethod = typeof merchandiseQuotePaymentMethods[number];
export type MerchandiseQuoteEligibility = "PUBLIC" | "REGISTERED" | "STAFF";

export const merchandiseQuoteRequestSchema = z.strictObject({
  clientRequestId: z.string().trim().min(1).max(128),
  paymentMethod: z.enum(merchandiseQuotePaymentMethods),
  lines: z.array(z.strictObject({
    variantId: z.string().trim().min(1).max(128),
    quantity: z.number().int().min(1).max(1000),
  })).min(1).max(50),
}).superRefine((value, context) => {
  const seen = new Set<string>();
  value.lines.forEach((line, index) => {
    if (seen.has(line.variantId)) {
      context.addIssue({
        code: "custom",
        path: ["lines", index, "variantId"],
        message: "Each merchandise variant may appear only once.",
      });
    }
    seen.add(line.variantId);
  });
});

export type MerchandiseQuoteRequest = z.infer<typeof merchandiseQuoteRequestSchema>;

export type MerchandiseQuoteCatalog = {
  id: string;
  eventId: string;
  eventIsPublished: boolean;
  isEnabled: boolean;
  status: "DRAFT" | "PENDING_APPROVAL" | "APPROVED";
  taxRateBasisPoints: number;
  cardFeePercentageBasisPoints: number;
  cardFeeFixedCents: number;
  quoteTtlMinutes: number;
  products: Array<{
    id: string;
    name: string;
    isEnabled: boolean;
    isArchived: boolean;
    variants: Array<{
      id: string;
      label: string;
      isEnabled: boolean;
      isArchived: boolean;
      availability: {
        id: string;
        versionNumber: number;
        priceCents: number;
        taxTreatment: "TAXABLE" | "TAX_EXEMPT";
        feePolicy: "ABSORBED_BY_EVENT" | "PASSED_TO_BUYER";
        inventoryPolicy: "UNLIMITED" | "TRACKED";
        inventoryQuantity: number | null;
        salesStartsAt: Date | null;
        salesEndsAt: Date | null;
        minQuantity: number;
        maxQuantity: number | null;
        attendeeAvailability: string;
        isActive: boolean;
      } | null;
    }>;
  }>;
};

export type MerchandiseQuoteDraft = {
  requestFingerprint: string;
  catalogFingerprint: string;
  paymentMethod: MerchandiseQuotePaymentMethod;
  eligibilitySnapshot: MerchandiseQuoteEligibility;
  subtotalCents: number;
  taxCents: number;
  feeCents: number;
  totalCents: number;
  expiresAt: Date;
  lines: Array<{
    eventId: string;
    productId: string;
    productNameSnapshot: string;
    variantId: string;
    variantLabelSnapshot: string;
    availabilityId: string;
    unitPriceCentsSnapshot: number;
    quantity: number;
    taxTreatmentSnapshot: "TAXABLE" | "TAX_EXEMPT";
    feePolicySnapshot: "ABSORBED_BY_EVENT" | "PASSED_TO_BUYER";
    inventoryPolicy: "UNLIMITED" | "TRACKED";
    inventoryQuantity: number | null;
    lineSubtotalCents: number;
    lineTaxCents: number;
  }>;
};

export type MerchandiseQuoteErrorCode =
  | "CATALOG_UNAVAILABLE"
  | "INVALID_PRICING_POLICY"
  | "VARIANT_UNAVAILABLE"
  | "QUANTITY_NOT_ALLOWED"
  | "ELIGIBILITY_REQUIRED"
  | "OUT_OF_STOCK"
  | "IDEMPOTENCY_KEY_REUSED"
  | "QUOTE_NOT_FOUND"
  | "QUOTE_EXPIRED"
  | "QUOTE_STALE"
  | "QUOTE_RELEASED"
  | "QUOTE_COMPLETED"
  | "PAYMENT_METHOD_NOT_CARD"
  | "QUOTE_CONFLICT";

export class MerchandiseQuoteError extends Error {
  constructor(
    public readonly code: MerchandiseQuoteErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "MerchandiseQuoteError";
  }
}

function stableJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fingerprint(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function storedCents(value: bigint, message: string) {
  if (value < BigInt(0) || value > BigInt(2_147_483_647)) {
    throw new MerchandiseQuoteError("INVALID_PRICING_POLICY", message);
  }
  return Number(value);
}

function basisPointAmount(amountCents: number, basisPoints: number) {
  return storedCents(
    (BigInt(amountCents) * BigInt(basisPoints) + BigInt(5_000)) / BigInt(10_000),
    "The calculated merchandise tax does not fit in storage.",
  );
}

function cardFeeAmount(amountCents: number, basisPoints: number, fixedFeeCents: number) {
  if (amountCents <= 0) return 0;
  const denominator = BigInt(10_000) - BigInt(basisPoints);
  const numerator = BigInt(amountCents + fixedFeeCents) * BigInt(10_000);
  const grossCents = (numerator + denominator - BigInt(1)) / denominator;
  return storedCents(
    grossCents - BigInt(amountCents),
    "The calculated merchandise card fee does not fit in storage.",
  );
}

function validatePricingPolicy(catalog: MerchandiseQuoteCatalog) {
  const valid = Number.isSafeInteger(catalog.taxRateBasisPoints)
    && catalog.taxRateBasisPoints >= 0
    && catalog.taxRateBasisPoints <= 10_000
    && Number.isSafeInteger(catalog.cardFeePercentageBasisPoints)
    && catalog.cardFeePercentageBasisPoints >= 0
    && catalog.cardFeePercentageBasisPoints <= 2_000
    && Number.isSafeInteger(catalog.cardFeeFixedCents)
    && catalog.cardFeeFixedCents >= 0
    && catalog.cardFeeFixedCents <= 1_000
    && Number.isSafeInteger(catalog.quoteTtlMinutes)
    && catalog.quoteTtlMinutes >= 1
    && catalog.quoteTtlMinutes <= 1_440;
  if (!valid) {
    throw new MerchandiseQuoteError(
      "INVALID_PRICING_POLICY",
      "The approved merchandise pricing policy is invalid.",
    );
  }
}

function eligible(required: string, actual: MerchandiseQuoteEligibility) {
  if (required === "ALL") return true;
  if (required === "REGISTERED") return actual === "REGISTERED" || actual === "STAFF";
  if (required === "STAFF_ONLY") return actual === "STAFF";
  return false;
}

export function merchandiseQuoteRequestFingerprint(
  eventId: string,
  request: MerchandiseQuoteRequest,
  identity: { registrationId?: string | null; actorUserId?: string | null },
) {
  return fingerprint({
    version: 1,
    eventId,
    registrationId: identity.registrationId ?? null,
    actorUserId: identity.actorUserId ?? null,
    clientRequestId: request.clientRequestId,
    paymentMethod: request.paymentMethod,
    lines: [...request.lines].sort((left, right) => left.variantId.localeCompare(right.variantId)),
  });
}

export function buildMerchandiseQuoteDraft(input: {
  eventId: string;
  request: MerchandiseQuoteRequest;
  identity: { registrationId?: string | null; actorUserId?: string | null };
  eligibility: MerchandiseQuoteEligibility;
  catalog: MerchandiseQuoteCatalog;
  now: Date;
}): MerchandiseQuoteDraft {
  const { catalog, request, now } = input;
  if (
    catalog.eventId !== input.eventId
    || !catalog.eventIsPublished
    || !catalog.isEnabled
    || catalog.status !== "APPROVED"
  ) {
    throw new MerchandiseQuoteError(
      "CATALOG_UNAVAILABLE",
      "Merchandise sales are not currently available for this event.",
    );
  }
  validatePricingPolicy(catalog);

  const variants = new Map(catalog.products.flatMap((product) => (
    product.isEnabled && !product.isArchived
      ? product.variants.map((variant) => [variant.id, { product, variant }] as const)
      : []
  )));
  let subtotalCents = 0;
  let taxCents = 0;
  let cardFeeBaseCents = 0;
  const selectedCatalogFacts: unknown[] = [];

  const lines = request.lines.map((requestedLine) => {
    const selected = variants.get(requestedLine.variantId);
    const variant = selected?.variant;
    const availability = variant?.availability;
    const at = now.getTime();
    if (
      !selected
      || !variant
      || !availability
      || !variant.isEnabled
      || variant.isArchived
      || !availability.isActive
      || (availability.salesStartsAt && availability.salesStartsAt.getTime() > at)
      || (availability.salesEndsAt && availability.salesEndsAt.getTime() < at)
    ) {
      throw new MerchandiseQuoteError(
        "VARIANT_UNAVAILABLE",
        "A selected merchandise variant is no longer available.",
      );
    }
    if (!eligible(availability.attendeeAvailability, input.eligibility)) {
      throw new MerchandiseQuoteError(
        "ELIGIBILITY_REQUIRED",
        "The purchaser is not eligible for a selected merchandise variant.",
      );
    }
    if (
      requestedLine.quantity < availability.minQuantity
      || (availability.maxQuantity !== null && requestedLine.quantity > availability.maxQuantity)
    ) {
      throw new MerchandiseQuoteError(
        "QUANTITY_NOT_ALLOWED",
        "A selected quantity is outside the configured purchase limits.",
      );
    }
    if (
      !Number.isSafeInteger(availability.priceCents)
      || availability.priceCents < 0
      || (availability.inventoryPolicy === "UNLIMITED" && availability.inventoryQuantity !== null)
      || (availability.inventoryPolicy === "TRACKED"
        && (!Number.isSafeInteger(availability.inventoryQuantity)
          || (availability.inventoryQuantity ?? -1) < 0))
    ) {
      throw new MerchandiseQuoteError(
        "INVALID_PRICING_POLICY",
        "A selected merchandise variant has invalid persisted terms.",
      );
    }

    const lineSubtotalCents = storedCents(
      BigInt(availability.priceCents) * BigInt(requestedLine.quantity),
      "A merchandise line total does not fit in storage.",
    );
    const lineTaxCents = availability.taxTreatment === "TAXABLE"
      ? basisPointAmount(lineSubtotalCents, catalog.taxRateBasisPoints)
      : 0;
    subtotalCents = storedCents(BigInt(subtotalCents) + BigInt(lineSubtotalCents), "The merchandise subtotal does not fit in storage.");
    taxCents = storedCents(BigInt(taxCents) + BigInt(lineTaxCents), "The merchandise tax total does not fit in storage.");
    if (availability.feePolicy === "PASSED_TO_BUYER") {
      cardFeeBaseCents = storedCents(
        BigInt(cardFeeBaseCents) + BigInt(lineSubtotalCents) + BigInt(lineTaxCents),
        "The merchandise card-fee base does not fit in storage.",
      );
    }

    selectedCatalogFacts.push({
      productId: selected.product.id,
      productName: selected.product.name,
      productEnabled: selected.product.isEnabled,
      productArchived: selected.product.isArchived,
      variantId: variant.id,
      variantLabel: variant.label,
      variantEnabled: variant.isEnabled,
      variantArchived: variant.isArchived,
      availability,
    });
    return {
      eventId: input.eventId,
      productId: selected.product.id,
      productNameSnapshot: selected.product.name,
      variantId: variant.id,
      variantLabelSnapshot: variant.label,
      availabilityId: availability.id,
      unitPriceCentsSnapshot: availability.priceCents,
      quantity: requestedLine.quantity,
      taxTreatmentSnapshot: availability.taxTreatment,
      feePolicySnapshot: availability.feePolicy,
      inventoryPolicy: availability.inventoryPolicy,
      inventoryQuantity: availability.inventoryQuantity,
      lineSubtotalCents,
      lineTaxCents,
    };
  });

  const feeCents = request.paymentMethod === "CARD"
    ? cardFeeAmount(
      cardFeeBaseCents,
      catalog.cardFeePercentageBasisPoints,
      catalog.cardFeeFixedCents,
    )
    : 0;
  const totalCents = storedCents(
    BigInt(subtotalCents) + BigInt(taxCents) + BigInt(feeCents),
    "The merchandise quote total does not fit in storage.",
  );
  const catalogFingerprint = fingerprint({
    version: 1,
    catalogId: catalog.id,
    eventIsPublished: catalog.eventIsPublished,
    isEnabled: catalog.isEnabled,
    status: catalog.status,
    taxRateBasisPoints: catalog.taxRateBasisPoints,
    cardFeePercentageBasisPoints: catalog.cardFeePercentageBasisPoints,
    cardFeeFixedCents: catalog.cardFeeFixedCents,
    quoteTtlMinutes: catalog.quoteTtlMinutes,
    selectedCatalogFacts: selectedCatalogFacts.sort((left, right) => (
      stableJson(left).localeCompare(stableJson(right))
    )),
  });

  return {
    requestFingerprint: merchandiseQuoteRequestFingerprint(
      input.eventId,
      request,
      input.identity,
    ),
    catalogFingerprint,
    paymentMethod: request.paymentMethod,
    eligibilitySnapshot: input.eligibility,
    subtotalCents,
    taxCents,
    feeCents,
    totalCents,
    expiresAt: new Date(now.getTime() + catalog.quoteTtlMinutes * 60_000),
    lines,
  };
}

export function assertMerchandiseInventoryAvailable(
  draft: MerchandiseQuoteDraft,
  reservedQuantityByVariant: ReadonlyMap<string, number>,
) {
  for (const line of draft.lines) {
    if (line.inventoryPolicy !== "TRACKED") continue;
    const reserved = reservedQuantityByVariant.get(line.variantId) ?? 0;
    const available = (line.inventoryQuantity ?? 0) - reserved;
    if (available < line.quantity) {
      throw new MerchandiseQuoteError(
        "OUT_OF_STOCK",
        "A selected merchandise variant no longer has enough inventory.",
      );
    }
  }
}

export function replayMerchandiseQuote<T extends { requestFingerprint: string }>(
  existing: T,
  requestFingerprint: string,
) {
  if (existing.requestFingerprint !== requestFingerprint) {
    throw new MerchandiseQuoteError(
      "IDEMPOTENCY_KEY_REUSED",
      "That request ID was already used for a different merchandise quote.",
    );
  }
  return existing;
}
