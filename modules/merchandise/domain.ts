import { createHash } from "node:crypto";

export type MerchandiseInventoryPolicy = "UNLIMITED" | "TRACKED";
export type MerchandiseTaxTreatment = "TAXABLE" | "TAX_EXEMPT";
export type MerchandiseFeePolicy = "ABSORBED_BY_EVENT" | "PASSED_TO_BUYER";

export type MerchandiseCatalog = {
  eventId: string;
  isPublished: boolean;
  products: Array<{
    id: string;
    eventId: string;
    name: string;
    isEnabled: boolean;
    variants: Array<{
      id: string;
      label: string;
      isEnabled: boolean;
      availability: {
        id: string;
        priceCents: number;
        taxTreatment: MerchandiseTaxTreatment;
        feePolicy: MerchandiseFeePolicy;
        inventoryPolicy: MerchandiseInventoryPolicy;
        inventoryQuantity: number | null;
        isActive: boolean;
      } | null;
    }>;
  }>;
};

export type MerchandiseOrderRequest = {
  eventId: string;
  registrationId?: string | null;
  purchaserSnapshot: Record<string, unknown>;
  clientRequestId: string;
  feeCents?: number;
  taxCents?: number;
  lines: Array<{
    variantId: string;
    quantity: number;
  }>;
};

export type MerchandiseOrderDraft = {
  eventId: string;
  registrationId: string | null;
  purchaserSnapshot: Record<string, unknown>;
  clientRequestId: string;
  requestFingerprint: string;
  subtotalCents: number;
  feeCents: number;
  taxCents: number;
  totalCents: number;
  lines: Array<{
    eventId: string;
    productId: string;
    productNameSnapshot: string;
    variantId: string;
    variantLabelSnapshot: string;
    availabilityId: string;
    unitPriceCentsSnapshot: number;
    quantity: number;
    taxTreatmentSnapshot: MerchandiseTaxTreatment;
    feePolicySnapshot: MerchandiseFeePolicy;
    lineTotalCents: number;
  }>;
};

export type MerchandiseOrderErrorCode =
  | "EVENT_UNAVAILABLE"
  | "EMPTY_ORDER"
  | "DUPLICATE_VARIANT"
  | "VARIANT_UNAVAILABLE"
  | "INVALID_QUANTITY"
  | "INVALID_MONEY"
  | "INVALID_INVENTORY_CONFIGURATION"
  | "INVALID_REQUEST_ID"
  | "IDEMPOTENCY_KEY_REUSED";

export class MerchandiseOrderError extends Error {
  constructor(
    public readonly code: MerchandiseOrderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MerchandiseOrderError";
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function merchandiseOrderFingerprint(input: MerchandiseOrderRequest) {
  return createHash("sha256")
    .update(stableJson({
      eventId: input.eventId,
      registrationId: input.registrationId ?? null,
      purchaserSnapshot: input.purchaserSnapshot,
      clientRequestId: input.clientRequestId,
      feeCents: input.feeCents ?? 0,
      taxCents: input.taxCents ?? 0,
      lines: input.lines,
    }))
    .digest("hex");
}

function nonNegativeCents(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MerchandiseOrderError(
      "INVALID_MONEY",
      `${label} must be a non-negative whole number of cents.`,
    );
  }
  return value;
}

function positiveQuantity(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new MerchandiseOrderError(
      "INVALID_QUANTITY",
      "Merchandise quantities must be positive whole numbers.",
    );
  }
  return value;
}

function safeAdd(left: number, right: number) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new MerchandiseOrderError(
      "INVALID_MONEY",
      "The merchandise order total is too large.",
    );
  }
  return result;
}

export function visibleMerchandiseCatalog(catalog: MerchandiseCatalog) {
  if (!catalog.isPublished) return [];

  return catalog.products.flatMap((product) => {
    if (!product.isEnabled || product.eventId !== catalog.eventId) return [];
    const variants = product.variants.filter((variant) => (
      variant.isEnabled && variant.availability?.isActive
    ));
    return variants.length > 0 ? [{ ...product, variants }] : [];
  });
}

export function buildMerchandiseOrderDraft(
  input: MerchandiseOrderRequest,
  catalog: MerchandiseCatalog,
): MerchandiseOrderDraft {
  if (
    input.clientRequestId.trim() !== input.clientRequestId
    || input.clientRequestId.length < 1
    || input.clientRequestId.length > 128
  ) {
    throw new MerchandiseOrderError(
      "INVALID_REQUEST_ID",
      "A request ID of at most 128 characters is required.",
    );
  }
  if (
    !catalog.isPublished
    || catalog.eventId !== input.eventId
  ) {
    throw new MerchandiseOrderError(
      "EVENT_UNAVAILABLE",
      "Merchandise is not available for this event.",
    );
  }
  if (input.lines.length === 0) {
    throw new MerchandiseOrderError(
      "EMPTY_ORDER",
      "Choose at least one merchandise item.",
    );
  }

  const visibleProducts = visibleMerchandiseCatalog(catalog);
  const variants = new Map(visibleProducts.flatMap((product) => (
    product.variants.map((variant) => [variant.id, { product, variant }] as const)
  )));
  const seenVariants = new Set<string>();
  let subtotalCents = 0;

  const lines = input.lines.map((requestedLine) => {
    if (seenVariants.has(requestedLine.variantId)) {
      throw new MerchandiseOrderError(
        "DUPLICATE_VARIANT",
        "Each merchandise variant may appear only once in an order.",
      );
    }
    seenVariants.add(requestedLine.variantId);

    const entry = variants.get(requestedLine.variantId);
    const availability = entry?.variant.availability;
    if (!entry || !availability) {
      throw new MerchandiseOrderError(
        "VARIANT_UNAVAILABLE",
        "A selected merchandise variant is no longer available.",
      );
    }
    if (
      (availability.inventoryPolicy === "UNLIMITED"
        && availability.inventoryQuantity !== null)
      || (availability.inventoryPolicy === "TRACKED"
        && (!Number.isSafeInteger(availability.inventoryQuantity)
          || (availability.inventoryQuantity ?? -1) < 0))
    ) {
      throw new MerchandiseOrderError(
        "INVALID_INVENTORY_CONFIGURATION",
        "The selected merchandise variant has an invalid inventory configuration.",
      );
    }

    const quantity = positiveQuantity(requestedLine.quantity);
    const unitPriceCents = nonNegativeCents(
      availability.priceCents,
      "Unit price",
    );
    const lineTotalCents = unitPriceCents * quantity;
    if (!Number.isSafeInteger(lineTotalCents)) {
      throw new MerchandiseOrderError(
        "INVALID_MONEY",
        "A merchandise line total is too large.",
      );
    }
    subtotalCents = safeAdd(subtotalCents, lineTotalCents);

    return {
      eventId: input.eventId,
      productId: entry.product.id,
      productNameSnapshot: entry.product.name,
      variantId: entry.variant.id,
      variantLabelSnapshot: entry.variant.label,
      availabilityId: availability.id,
      unitPriceCentsSnapshot: unitPriceCents,
      quantity,
      taxTreatmentSnapshot: availability.taxTreatment,
      feePolicySnapshot: availability.feePolicy,
      lineTotalCents,
    };
  });

  const feeCents = nonNegativeCents(input.feeCents ?? 0, "Fee");
  const taxCents = nonNegativeCents(input.taxCents ?? 0, "Tax");
  const totalCents = safeAdd(safeAdd(subtotalCents, feeCents), taxCents);

  return {
    eventId: input.eventId,
    registrationId: input.registrationId ?? null,
    purchaserSnapshot: structuredClone(input.purchaserSnapshot),
    clientRequestId: input.clientRequestId,
    requestFingerprint: merchandiseOrderFingerprint(input),
    subtotalCents,
    feeCents,
    taxCents,
    totalCents,
    lines,
  };
}

export function replayMerchandiseOrder<
  T extends { requestFingerprint: string },
>(
  existing: T,
  request: MerchandiseOrderRequest,
) {
  if (existing.requestFingerprint !== merchandiseOrderFingerprint(request)) {
    throw new MerchandiseOrderError(
      "IDEMPOTENCY_KEY_REUSED",
      "That request ID was already used for a different merchandise order.",
    );
  }
  return existing;
}
