import "server-only";

import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import {
  merchandiseCatalogInputSchema,
  productInputSchema,
  validateArtworkLink,
  variantInputSchema,
  type MerchandiseProjectionInput,
} from "@/modules/merchandise/catalog-domain";

export type MerchandiseCatalogErrorCode = "CATALOG_NOT_FOUND" | "PRODUCT_NOT_FOUND" | "VARIANT_NOT_FOUND" | "ASSET_NOT_FOUND" | "ARCHIVED_REFERENCE";
export class MerchandiseCatalogOperationError extends Error {
  constructor(public readonly code: MerchandiseCatalogErrorCode, message: string) { super(message); this.name = "MerchandiseCatalogOperationError"; }
}

const availabilitySelect = { id: true, priceCents: true, taxTreatment: true, feePolicy: true, inventoryPolicy: true, inventoryQuantity: true, minQuantity: true, maxQuantity: true, attendeeAvailability: true, salesStartsAt: true, salesEndsAt: true, isActive: true } as const;
const productInclude = { artwork: { select: { id: true } }, variants: { orderBy: [{ position: "asc" }, { createdAt: "asc" }], include: { availability: { where: { isActive: true }, take: 1, select: availabilitySelect } } } } satisfies Prisma.MerchandiseProductInclude;
type CatalogProduct = Prisma.MerchandiseProductGetPayload<{ include: typeof productInclude }>;

function iso(value: Date | null) { return value?.toISOString() ?? null; }
function projectProduct(product: CatalogProduct, admin: boolean) {
  return {
    id: product.id, eventId: product.eventId, name: product.name, description: product.description,
    ...(admin ? { isEnabled: product.isEnabled, isArchived: product.isArchived, position: product.position, updatedAt: product.updatedAt.toISOString() } : {}),
    artwork: product.artworkAssetId && product.artworkAltText ? { assetId: product.artworkAssetId, altText: product.artworkAltText } : null,
    variants: product.variants.filter((v) => admin || (v.isEnabled && !v.isArchived)).map((v) => ({
      id: v.id, label: v.label, ...(admin ? { sku: v.sku, isEnabled: v.isEnabled, isArchived: v.isArchived, position: v.position } : {}),
      availability: v.availability[0] ? { ...v.availability[0], salesStartsAt: iso(v.availability[0].salesStartsAt), salesEndsAt: iso(v.availability[0].salesEndsAt) } : null,
    })),
  };
}

export async function getMerchandiseCatalog(eventId: string, admin = true) {
  const prisma = getPrisma();
  const catalog = await prisma.merchandiseCatalog.findUnique({ where: { eventId }, include: { event: { select: { isPublished: true } } } });
  if (!catalog) return { eventId, isEnabled: false, status: "DRAFT" as const, products: [] };
  if (!admin && !catalog.event.isPublished) return { eventId, isEnabled: false, status: catalog.status, products: [] };
  const products = await prisma.merchandiseProduct.findMany({ where: { eventId, ...(admin ? {} : { isEnabled: true, isArchived: false }) }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], include: productInclude });
  return { eventId, isEnabled: catalog.isEnabled, status: catalog.status, ...(admin ? { updatedAt: catalog.updatedAt.toISOString() } : {}), products: products.map((p) => projectProduct(p, admin)) };
}

async function eventAssetForProduct(eventId: string, assetId: string) {
  const asset = await getPrisma().eventAsset.findFirst({ where: { id: assetId, eventId }, select: { id: true } });
  if (!asset) throw new MerchandiseCatalogOperationError("ASSET_NOT_FOUND", "The artwork asset does not belong to this event.");
}

export async function saveCatalog(eventId: string, raw: unknown, actorUserId: string) {
  const input = merchandiseCatalogInputSchema.parse(raw);
  return getPrisma().$transaction(async (tx) => {
    const before = await tx.merchandiseCatalog.findUnique({ where: { eventId } });
    const next = await tx.merchandiseCatalog.upsert({ where: { eventId }, create: { eventId, isEnabled: input.isEnabled ?? false, status: input.status ?? "DRAFT" }, update: { ...(input.isEnabled === undefined ? {} : { isEnabled: input.isEnabled }), ...(input.status === undefined ? {} : { status: input.status }) } });
    await writeAuditLog({ eventId, actorUserId, action: "MERCHANDISE_CATALOG_UPDATED", entityType: "MerchandiseCatalog", entityId: next.id, summary: "Updated merchandise catalog configuration.", metadata: { before: before ? { isEnabled: before.isEnabled, status: before.status } : null, after: { isEnabled: next.isEnabled, status: next.status } } }, tx);
    return getMerchandiseCatalog(eventId, true);
  });
}

export async function createProduct(eventId: string, raw: unknown, actorUserId: string) {
  const input = productInputSchema.parse(raw);
  if (input.artwork) { validateArtworkLink(input.artwork); await eventAssetForProduct(eventId, input.artwork.assetId); }
  return getPrisma().$transaction(async (tx) => {
    const product = await tx.merchandiseProduct.create({ data: { eventId, name: input.name, description: input.description ?? null, isEnabled: input.isEnabled, isArchived: input.isArchived, position: input.position, artworkAssetId: input.artwork?.assetId, artworkAltText: input.artwork?.altText }, include: productInclude });
    await writeAuditLog({ eventId, actorUserId, action: "MERCHANDISE_PRODUCT_CREATED", entityType: "MerchandiseProduct", entityId: product.id, summary: `Created merchandise product ${product.name}.`, metadata: { after: { name: product.name, isEnabled: product.isEnabled, isArchived: product.isArchived, position: product.position, artworkAssetId: product.artworkAssetId, artworkAltText: product.artworkAltText } } }, tx);
    return projectProduct(product, true);
  });
}

export async function updateProduct(eventId: string, productId: string, raw: unknown, actorUserId: string) {
  const input = productInputSchema.parse(raw);
  if (input.artwork) { validateArtworkLink(input.artwork); await eventAssetForProduct(eventId, input.artwork.assetId); }
  return getPrisma().$transaction(async (tx) => {
    const before = await tx.merchandiseProduct.findFirst({ where: { id: productId, eventId }, include: productInclude });
    if (!before) throw new MerchandiseCatalogOperationError("PRODUCT_NOT_FOUND", "The product does not belong to this event.");
    const product = await tx.merchandiseProduct.update({ where: { id: productId }, data: { name: input.name, description: input.description ?? null, isEnabled: input.isEnabled, isArchived: input.isArchived, position: input.position, artworkAssetId: input.artwork?.assetId ?? null, artworkAltText: input.artwork?.altText ?? null }, include: productInclude });
    await writeAuditLog({ eventId, actorUserId, action: product.isArchived ? "MERCHANDISE_PRODUCT_ARCHIVED" : "MERCHANDISE_PRODUCT_UPDATED", entityType: "MerchandiseProduct", entityId: product.id, summary: `Updated merchandise product ${product.name}.`, metadata: { before: { name: before.name, isEnabled: before.isEnabled, isArchived: before.isArchived, position: before.position }, after: { name: product.name, isEnabled: product.isEnabled, isArchived: product.isArchived, position: product.position } } }, tx);
    return projectProduct(product, true);
  });
}

export async function createVariant(eventId: string, productId: string, raw: unknown, actorUserId: string) {
  const input = variantInputSchema.parse(raw);
  return getPrisma().$transaction(async (tx) => {
    const product = await tx.merchandiseProduct.findFirst({ where: { id: productId, eventId } });
    if (!product) throw new MerchandiseCatalogOperationError("PRODUCT_NOT_FOUND", "The product does not belong to this event.");
    const variant = await tx.merchandiseProductVariant.create({ data: { productId, label: input.label, sku: input.sku ?? null, isEnabled: input.isEnabled, isArchived: input.isArchived, position: input.position, ...(input.availability ? { availability: { create: { versionNumber: 1, priceCents: input.availability.priceCents, taxTreatment: input.availability.taxTreatment, feePolicy: input.availability.feePolicy, inventoryPolicy: input.availability.inventoryPolicy, inventoryQuantity: input.availability.inventoryQuantity, salesStartsAt: input.availability.salesStartsAt ? new Date(input.availability.salesStartsAt) : null, salesEndsAt: input.availability.salesEndsAt ? new Date(input.availability.salesEndsAt) : null, minQuantity: input.availability.minQuantity, maxQuantity: input.availability.maxQuantity, attendeeAvailability: input.availability.attendeeAvailability, isActive: input.availability.isActive, reason: input.availability.reason, createdByUserId: actorUserId } } } : {}), }, include: { availability: { where: { isActive: true }, select: availabilitySelect } } });
    await writeAuditLog({ eventId, actorUserId, action: "MERCHANDISE_VARIANT_CREATED", entityType: "MerchandiseProductVariant", entityId: variant.id, summary: `Created merchandise variant ${variant.label}.`, metadata: { after: { label: variant.label, priceCents: variant.availability[0]?.priceCents ?? null } } }, tx);
    return { id: variant.id, label: variant.label, sku: variant.sku, isEnabled: variant.isEnabled, isArchived: variant.isArchived, position: variant.position, availability: variant.availability[0] ? { ...variant.availability[0], salesStartsAt: iso(variant.availability[0].salesStartsAt), salesEndsAt: iso(variant.availability[0].salesEndsAt) } : null };
  });
}

export async function updateVariant(eventId: string, productId: string, variantId: string, raw: unknown, actorUserId: string) {
  const input = variantInputSchema.parse(raw);
  return getPrisma().$transaction(async (tx) => {
    const before = await tx.merchandiseProductVariant.findFirst({ where: { id: variantId, productId, product: { eventId } }, include: { availability: { where: { isActive: true }, take: 1 } } });
    if (!before) throw new MerchandiseCatalogOperationError("VARIANT_NOT_FOUND", "The variant does not belong to this product.");
    const variant = await tx.merchandiseProductVariant.update({ where: { id: variantId }, data: { label: input.label, sku: input.sku ?? null, isEnabled: input.isEnabled, isArchived: input.isArchived, position: input.position, ...(input.availability ? { availability: { updateMany: { where: { isActive: true }, data: { isActive: false } }, create: { versionNumber: (before.availability[0]?.versionNumber ?? 0) + 1, priceCents: input.availability.priceCents, taxTreatment: input.availability.taxTreatment, feePolicy: input.availability.feePolicy, inventoryPolicy: input.availability.inventoryPolicy, inventoryQuantity: input.availability.inventoryQuantity, salesStartsAt: input.availability.salesStartsAt ? new Date(input.availability.salesStartsAt) : null, salesEndsAt: input.availability.salesEndsAt ? new Date(input.availability.salesEndsAt) : null, minQuantity: input.availability.minQuantity, maxQuantity: input.availability.maxQuantity, attendeeAvailability: input.availability.attendeeAvailability, isActive: input.availability.isActive, reason: input.availability.reason, createdByUserId: actorUserId } } } : {}) } });
    await writeAuditLog({ eventId, actorUserId, action: variant.isArchived ? "MERCHANDISE_VARIANT_ARCHIVED" : "MERCHANDISE_VARIANT_UPDATED", entityType: "MerchandiseProductVariant", entityId: variant.id, summary: `Updated merchandise variant ${variant.label}.`, metadata: { before: { label: before.label, isEnabled: before.isEnabled, isArchived: before.isArchived, priceCents: before.availability[0]?.priceCents ?? null }, after: { label: variant.label, isEnabled: variant.isEnabled, isArchived: variant.isArchived, priceCents: input.availability?.priceCents ?? before.availability[0]?.priceCents ?? null } } }, tx);
    return variant;
  });
}

export async function archiveVariant(eventId: string, variantId: string, actorUserId: string) {
  return getPrisma().$transaction(async (tx) => {
    const before = await tx.merchandiseProductVariant.findFirst({ where: { id: variantId, product: { eventId } } });
    if (!before) throw new MerchandiseCatalogOperationError("VARIANT_NOT_FOUND", "The variant does not belong to this event.");
    const variant = await tx.merchandiseProductVariant.update({ where: { id: variantId }, data: { isEnabled: false, isArchived: true } });
    await writeAuditLog({ eventId, actorUserId, action: "MERCHANDISE_VARIANT_ARCHIVED", entityType: "MerchandiseProductVariant", entityId: variant.id, summary: `Archived merchandise variant ${variant.label}.`, metadata: { before: { isEnabled: before.isEnabled, isArchived: before.isArchived }, after: { isEnabled: false, isArchived: true } } }, tx);
    return variant;
  });
}

export type { MerchandiseProjectionInput };
