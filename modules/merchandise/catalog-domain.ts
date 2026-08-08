import { z } from "zod";

export class MerchandiseCatalogError extends Error {
  constructor(public readonly code: "INVALID_ARTWORK" | "INVALID_CONFIGURATION" | "INVALID_AVAILABILITY", message: string) {
    super(message);
    this.name = "MerchandiseCatalogError";
  }
}

export const merchandiseCatalogInputSchema = z.object({
  isEnabled: z.boolean().optional(),
  status: z.enum(["DRAFT", "PENDING_APPROVAL", "APPROVED"]).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === "APPROVED") {
    ctx.addIssue({ code: "custom", path: ["status"], message: "Catalog approval is a human-only activation gate." });
  }
  if (value.status === "APPROVED" && value.isEnabled !== true) {
    ctx.addIssue({ code: "custom", path: ["isEnabled"], message: "An approved catalog must be explicitly enabled." });
  }
});

export const productInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().max(2000).nullable().optional(),
  isEnabled: z.boolean().default(true),
  isArchived: z.boolean().default(false),
  position: z.number().int().min(0).max(100000).default(0),
  artwork: z.object({ assetId: z.string().trim().min(1).max(100), altText: z.string().trim().min(3).max(300) }).nullable().optional(),
}).strict();

export const variantInputSchema = z.object({
  label: z.string().trim().min(1).max(100),
  sku: z.string().trim().max(100).nullable().optional(),
  isEnabled: z.boolean().default(true),
  isArchived: z.boolean().default(false),
  position: z.number().int().min(0).max(100000).default(0),
  availability: z.object({
    priceCents: z.number().int().min(0).max(100000000),
    taxTreatment: z.enum(["TAXABLE", "TAX_EXEMPT"]).default("TAXABLE"),
    feePolicy: z.enum(["ABSORBED_BY_EVENT", "PASSED_TO_BUYER"]).default("ABSORBED_BY_EVENT"),
    inventoryPolicy: z.enum(["UNLIMITED", "TRACKED"]).default("UNLIMITED"),
    inventoryQuantity: z.number().int().min(0).nullable().default(null),
    salesStartsAt: z.string().datetime().nullable().default(null),
    salesEndsAt: z.string().datetime().nullable().default(null),
    minQuantity: z.number().int().min(1).max(1000).default(1),
    maxQuantity: z.number().int().min(1).max(1000).nullable().default(null),
    attendeeAvailability: z.enum(["ALL", "REGISTERED", "STAFF_ONLY"]).default("ALL"),
    isActive: z.boolean().default(true),
    reason: z.string().trim().max(500).nullable().default(null),
  }).superRefine((value, ctx) => {
    if (value.inventoryPolicy === "UNLIMITED" && value.inventoryQuantity !== null) ctx.addIssue({ code: "custom", path: ["inventoryQuantity"], message: "Unlimited inventory cannot have a quantity." });
    if (value.inventoryPolicy === "TRACKED" && value.inventoryQuantity === null) ctx.addIssue({ code: "custom", path: ["inventoryQuantity"], message: "Tracked inventory requires a quantity." });
    if (value.maxQuantity !== null && value.maxQuantity < value.minQuantity) ctx.addIssue({ code: "custom", path: ["maxQuantity"], message: "Maximum quantity must be at least the minimum." });
    if (value.salesStartsAt && value.salesEndsAt && value.salesStartsAt > value.salesEndsAt) ctx.addIssue({ code: "custom", path: ["salesEndsAt"], message: "Sales end must be after sales start." });
  }),
}).strict();

export function validateArtworkLink(value: { assetId: string; altText: string }) {
  const assetId = value.assetId.trim();
  const altText = value.altText.trim();
  if (!assetId || altText.length < 3 || altText.length > 300) throw new MerchandiseCatalogError("INVALID_ARTWORK", "Artwork requires a verified asset and meaningful alt text.");
  return { assetId, altText };
}

export type MerchandiseProjectionInput = {
  eventId: string; status: "DRAFT" | "PENDING_APPROVAL" | "APPROVED"; isEnabled: boolean;
  products: Array<{ id: string; eventId: string; name: string; description: string | null; isEnabled: boolean; isArchived: boolean; position: number; artwork: { assetId: string; altText: string } | null; variants: Array<{ id: string; label: string; sku: string | null; isEnabled: boolean; isArchived: boolean; availability: { id: string; priceCents: number; taxTreatment: "TAXABLE" | "TAX_EXEMPT"; feePolicy: "ABSORBED_BY_EVENT" | "PASSED_TO_BUYER"; inventoryPolicy: "UNLIMITED" | "TRACKED"; inventoryQuantity: number | null; minQuantity: number; maxQuantity: number | null; attendeeAvailability: string; salesStartsAt: string | null; salesEndsAt: string | null; isActive: boolean } | null }> }>;
};

export function projectMerchandiseCatalog(catalog: MerchandiseProjectionInput, now = new Date().toISOString()) {
  if (!catalog.isEnabled || catalog.status !== "APPROVED") return { eventId: catalog.eventId, products: [] };
  const at = Date.parse(now);
  return {
    eventId: catalog.eventId,
    products: catalog.products.filter((p) => p.eventId === catalog.eventId && p.isEnabled && !p.isArchived).sort((a, b) => a.position - b.position).flatMap((product) => {
      const variants = product.variants.filter((v) => v.isEnabled && !v.isArchived && v.availability?.isActive && (!v.availability.salesStartsAt || Date.parse(v.availability.salesStartsAt) <= at) && (!v.availability.salesEndsAt || Date.parse(v.availability.salesEndsAt) >= at));
      return variants.length ? [{ ...product, variants }] : [];
    }),
  };
}
