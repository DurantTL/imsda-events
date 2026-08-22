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

export type MerchandiseCatalogErrorCode = "CATALOG_NOT_FOUND" | "PRODUCT_NOT_FOUND" | "VARIANT_NOT_FOUND" | "ASSET_NOT_FOUND" | "ASSET_NOT_IMAGE" | "ARCHIVED_REFERENCE";
export class MerchandiseCatalogOperationError extends Error {
  constructor(public readonly code: MerchandiseCatalogErrorCode, message: string) { super(message); this.name = "MerchandiseCatalogOperationError"; }
}

const availabilitySelect = { id: true, priceCents: true, taxTreatment: true, feePolicy: true, inventoryPolicy: true, inventoryQuantity: true, minQuantity: true, maxQuantity: true, attendeeAvailability: true, salesStartsAt: true, salesEndsAt: true, isActive: true, versionNumber: true, reason: true } as const;
/** The latest version by number, regardless of `isActive`: a paused or
 * archived variant must still show staff its last configured price/terms
 * instead of going blank. Public visibility is decided separately, downstream,
 * by projectMerchandiseCatalog reading `isActive` off this same row. */
const latestAvailabilityInclude = { orderBy: { versionNumber: "desc" as const }, take: 1, select: availabilitySelect };
const productInclude = { artwork: { select: { id: true } }, variants: { orderBy: [{ position: "asc" }, { createdAt: "asc" }], include: { availability: latestAvailabilityInclude } } } satisfies Prisma.MerchandiseProductInclude;
type CatalogProduct = Prisma.MerchandiseProductGetPayload<{ include: typeof productInclude }>;
type CatalogVariant = CatalogProduct["variants"][number];
type CatalogAvailability = CatalogVariant["availability"][number];

function iso(value: Date | null) { return value?.toISOString() ?? null; }

/** The URL a staff member's browser can load inline. Never attachment-only:
 * the artwork picker needs to render a thumbnail, not force a download. */
function artworkUrl(eventId: string, assetId: string) {
  return `/api/events/${encodeURIComponent(eventId)}/assets/${encodeURIComponent(assetId)}?disposition=inline`;
}

function projectAvailability(availability: CatalogAvailability | undefined) {
  if (!availability) return null;
  return {
    id: availability.id,
    versionNumber: availability.versionNumber,
    priceCents: availability.priceCents,
    taxTreatment: availability.taxTreatment,
    feePolicy: availability.feePolicy,
    inventoryPolicy: availability.inventoryPolicy,
    inventoryQuantity: availability.inventoryQuantity,
    minQuantity: availability.minQuantity,
    maxQuantity: availability.maxQuantity,
    attendeeAvailability: availability.attendeeAvailability,
    salesStartsAt: iso(availability.salesStartsAt),
    salesEndsAt: iso(availability.salesEndsAt),
    isActive: availability.isActive,
    reason: availability.reason,
  };
}

/** Always built from the latest version, active or not, so an edit made
 * while a variant is paused or archived still leaves a true before/after
 * record instead of recording a null where the price used to be. */
function auditAvailabilitySnapshot(availability: CatalogAvailability | undefined) {
  if (!availability) return null;
  return {
    versionNumber: availability.versionNumber,
    priceCents: availability.priceCents,
    taxTreatment: availability.taxTreatment,
    feePolicy: availability.feePolicy,
    inventoryPolicy: availability.inventoryPolicy,
    inventoryQuantity: availability.inventoryQuantity,
    minQuantity: availability.minQuantity,
    maxQuantity: availability.maxQuantity,
    attendeeAvailability: availability.attendeeAvailability,
    salesStartsAt: iso(availability.salesStartsAt),
    salesEndsAt: iso(availability.salesEndsAt),
    isActive: availability.isActive,
    reason: availability.reason,
  };
}

/** The single shape every repository response returns. Staff-only fields
 * (isEnabled, isArchived, position, sku) are safe here because this function
 * is never used to build a public/attendee-facing response — that DTO is
 * built explicitly and separately by projectMerchandiseCatalog. */
function projectProduct(eventId: string, product: CatalogProduct) {
  return {
    id: product.id,
    eventId: product.eventId,
    name: product.name,
    description: product.description,
    isEnabled: product.isEnabled,
    isArchived: product.isArchived,
    position: product.position,
    updatedAt: product.updatedAt.toISOString(),
    artwork: product.artworkAssetId && product.artworkAltText
      ? { id: product.artworkAssetId, altText: product.artworkAltText, url: artworkUrl(eventId, product.artworkAssetId) }
      : null,
    variants: product.variants.map((v) => ({
      id: v.id,
      label: v.label,
      sku: v.sku,
      isEnabled: v.isEnabled,
      isArchived: v.isArchived,
      position: v.position,
      availability: projectAvailability(v.availability[0]),
    })),
  };
}

/**
 * `client` defaults to the top-level connection but accepts an open `tx` so a
 * caller composing this inside its own transaction (saveCatalog) reads back
 * exactly what it just wrote, not a separate connection's possibly-stale view
 * of rows the transaction hasn't committed yet.
 */
export async function getMerchandiseCatalog(eventId: string, client: Prisma.TransactionClient = getPrisma()) {
  const catalog = await client.merchandiseCatalog.findUnique({ where: { eventId } });
  const products = await client.merchandiseProduct.findMany({ where: { eventId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], include: productInclude });
  return {
    eventId,
    isEnabled: catalog?.isEnabled ?? false,
    status: catalog?.status ?? ("DRAFT" as const),
    updatedAt: catalog?.updatedAt.toISOString() ?? null,
    products: products.map((p) => projectProduct(eventId, p)),
  };
}

/** Raw, unfiltered catalog data shaped for projectMerchandiseCatalog. Every
 * product and variant is included regardless of enabled/archived state so the
 * pure domain function is the single place that decides what is safe to show
 * a given viewer.
 *
 * `includeUnpublishedEvent` is a staff-preview-only escape hatch that skips
 * the `event.isPublished` gate so a draft event/catalog can be reviewed
 * before human approval. Every other caller (any real public/attendee
 * consumer) omits it, so this function's default behavior — and therefore
 * the live projection gate — is unchanged. */
export async function getMerchandiseCatalogForProjection(eventId: string, options: { includeUnpublishedEvent?: boolean } = {}): Promise<MerchandiseProjectionInput> {
  const prisma = getPrisma();
  const [catalog, event, products] = await Promise.all([
    prisma.merchandiseCatalog.findUnique({ where: { eventId } }),
    prisma.event.findUnique({ where: { id: eventId }, select: { isPublished: true } }),
    prisma.merchandiseProduct.findMany({ where: { eventId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], include: productInclude }),
  ]);
  if (!options.includeUnpublishedEvent && (!catalog || !event?.isPublished)) return { eventId, isEnabled: false, status: "DRAFT", products: [] };
  return {
    eventId,
    isEnabled: catalog?.isEnabled ?? false,
    status: catalog?.status ?? "DRAFT",
    products: products.map((product) => ({
      id: product.id,
      eventId: product.eventId,
      name: product.name,
      description: product.description,
      isEnabled: product.isEnabled,
      isArchived: product.isArchived,
      position: product.position,
      artwork: product.artworkAssetId && product.artworkAltText ? { assetId: product.artworkAssetId, altText: product.artworkAltText } : null,
      variants: product.variants.map((v) => ({
        id: v.id,
        label: v.label,
        sku: v.sku,
        isEnabled: v.isEnabled,
        isArchived: v.isArchived,
        availability: v.availability[0] ? {
          id: v.availability[0].id,
          priceCents: v.availability[0].priceCents,
          taxTreatment: v.availability[0].taxTreatment,
          feePolicy: v.availability[0].feePolicy,
          inventoryPolicy: v.availability[0].inventoryPolicy,
          inventoryQuantity: v.availability[0].inventoryQuantity,
          minQuantity: v.availability[0].minQuantity,
          maxQuantity: v.availability[0].maxQuantity,
          attendeeAvailability: v.availability[0].attendeeAvailability,
          salesStartsAt: iso(v.availability[0].salesStartsAt),
          salesEndsAt: iso(v.availability[0].salesEndsAt),
          isActive: v.availability[0].isActive,
        } : null,
      })),
    })),
  };
}

/** Only an image can be safely inlined for a public storefront thumbnail — a
 * PDF or other document type is never eligible as product artwork, matching
 * the content-type gate eventAssetResponse applies when serving it. */
async function eventAssetForProduct(eventId: string, assetId: string) {
  const asset = await getPrisma().eventAsset.findFirst({ where: { id: assetId, eventId }, select: { id: true, contentType: true } });
  if (!asset) throw new MerchandiseCatalogOperationError("ASSET_NOT_FOUND", "The artwork asset does not belong to this event.");
  if (!asset.contentType.startsWith("image/")) throw new MerchandiseCatalogOperationError("ASSET_NOT_IMAGE", "Product artwork must be an image file.");
}

async function nextVersionNumber(tx: Prisma.TransactionClient, variantId: string) {
  const latest = await tx.merchandiseVariantAvailability.findFirst({ where: { variantId }, orderBy: { versionNumber: "desc" }, select: { versionNumber: true } });
  return (latest?.versionNumber ?? 0) + 1;
}

/** A created product's position is always assigned here, never taken from
 * the caller: every product created through the admin UI otherwise starts
 * at the schema default of 0, which makes moving a newly created product
 * indistinguishable from any other position-0 product and defeats staff
 * reordering. Appending past the current maximum (across every product,
 * including archived ones, so a reused position can never collide) keeps
 * creation order deterministic without staff having to set an order by hand. */
async function nextProductPosition(tx: Prisma.TransactionClient, eventId: string) {
  const last = await tx.merchandiseProduct.findFirst({ where: { eventId }, orderBy: { position: "desc" }, select: { position: true } });
  return (last?.position ?? -1) + 1;
}

/** Same rationale as nextProductPosition, scoped to one product's variants. */
async function nextVariantPosition(tx: Prisma.TransactionClient, productId: string) {
  const last = await tx.merchandiseProductVariant.findFirst({ where: { productId }, orderBy: { position: "desc" }, select: { position: true } });
  return (last?.position ?? -1) + 1;
}

export async function saveCatalog(eventId: string, raw: unknown, actorUserId: string) {
  const input = merchandiseCatalogInputSchema.parse(raw);
  return getPrisma().$transaction(async (tx) => {
    const before = await tx.merchandiseCatalog.findUnique({ where: { eventId } });
    const next = await tx.merchandiseCatalog.upsert({ where: { eventId }, create: { eventId, isEnabled: input.isEnabled ?? false, status: input.status ?? "DRAFT" }, update: { ...(input.isEnabled === undefined ? {} : { isEnabled: input.isEnabled }), ...(input.status === undefined ? {} : { status: input.status }) } });
    await writeAuditLog({ eventId, actorUserId, action: "MERCHANDISE_CATALOG_UPDATED", entityType: "MerchandiseCatalog", entityId: next.id, summary: "Updated merchandise catalog configuration.", metadata: { before: before ? { isEnabled: before.isEnabled, status: before.status } : null, after: { isEnabled: next.isEnabled, status: next.status } } }, tx);
    return getMerchandiseCatalog(eventId, tx);
  });
}

export async function createProduct(eventId: string, raw: unknown, actorUserId: string) {
  const input = productInputSchema.parse(raw);
  if (input.artwork) { validateArtworkLink(input.artwork); await eventAssetForProduct(eventId, input.artwork.assetId); }
  return getPrisma().$transaction(async (tx) => {
    const position = await nextProductPosition(tx, eventId);
    const product = await tx.merchandiseProduct.create({ data: { eventId, name: input.name, description: input.description ?? null, isEnabled: input.isEnabled, isArchived: input.isArchived, position, artworkAssetId: input.artwork?.assetId, artworkAltText: input.artwork?.altText }, include: productInclude });
    await writeAuditLog({ eventId, actorUserId, action: "MERCHANDISE_PRODUCT_CREATED", entityType: "MerchandiseProduct", entityId: product.id, summary: `Created merchandise product ${product.name}.`, metadata: { after: { name: product.name, description: product.description, isEnabled: product.isEnabled, isArchived: product.isArchived, position: product.position, artworkAssetId: product.artworkAssetId, artworkAltText: product.artworkAltText } } }, tx);
    return projectProduct(eventId, product);
  });
}

export async function updateProduct(eventId: string, productId: string, raw: unknown, actorUserId: string) {
  const input = productInputSchema.parse(raw);
  if (input.artwork) { validateArtworkLink(input.artwork); await eventAssetForProduct(eventId, input.artwork.assetId); }
  return getPrisma().$transaction(async (tx) => {
    const before = await tx.merchandiseProduct.findFirst({ where: { id: productId, eventId }, include: productInclude });
    if (!before) throw new MerchandiseCatalogOperationError("PRODUCT_NOT_FOUND", "The product does not belong to this event.");
    // Artwork is retained unless the caller explicitly supplies a new (or explicitly null) value.
    const artworkAssetId = input.artwork === undefined ? before.artworkAssetId : (input.artwork?.assetId ?? null);
    const artworkAltText = input.artwork === undefined ? before.artworkAltText : (input.artwork?.altText ?? null);
    const product = await tx.merchandiseProduct.update({ where: { id: productId }, data: { name: input.name, description: input.description ?? null, isEnabled: input.isEnabled, isArchived: input.isArchived, position: input.position, artworkAssetId, artworkAltText }, include: productInclude });
    await writeAuditLog({ eventId, actorUserId, action: product.isArchived ? "MERCHANDISE_PRODUCT_ARCHIVED" : "MERCHANDISE_PRODUCT_UPDATED", entityType: "MerchandiseProduct", entityId: product.id, summary: `Updated merchandise product ${product.name}.`, metadata: { before: { name: before.name, description: before.description, isEnabled: before.isEnabled, isArchived: before.isArchived, position: before.position, artworkAssetId: before.artworkAssetId, artworkAltText: before.artworkAltText }, after: { name: product.name, description: product.description, isEnabled: product.isEnabled, isArchived: product.isArchived, position: product.position, artworkAssetId: product.artworkAssetId, artworkAltText: product.artworkAltText } } }, tx);
    return projectProduct(eventId, product);
  });
}

export async function createVariant(eventId: string, productId: string, raw: unknown, actorUserId: string) {
  const input = variantInputSchema.parse(raw);
  return getPrisma().$transaction(async (tx) => {
    const product = await tx.merchandiseProduct.findFirst({ where: { id: productId, eventId } });
    if (!product) throw new MerchandiseCatalogOperationError("PRODUCT_NOT_FOUND", "The product does not belong to this event.");
    const position = await nextVariantPosition(tx, productId);
    const variant = await tx.merchandiseProductVariant.create({ data: { productId, label: input.label, sku: input.sku ?? null, isEnabled: input.isEnabled, isArchived: input.isArchived, position, ...(input.availability ? { availability: { create: { versionNumber: 1, priceCents: input.availability.priceCents, taxTreatment: input.availability.taxTreatment, feePolicy: input.availability.feePolicy, inventoryPolicy: input.availability.inventoryPolicy, inventoryQuantity: input.availability.inventoryQuantity, salesStartsAt: input.availability.salesStartsAt ? new Date(input.availability.salesStartsAt) : null, salesEndsAt: input.availability.salesEndsAt ? new Date(input.availability.salesEndsAt) : null, minQuantity: input.availability.minQuantity, maxQuantity: input.availability.maxQuantity, attendeeAvailability: input.availability.attendeeAvailability, isActive: input.availability.isActive && input.isEnabled && !input.isArchived, reason: input.availability.reason, createdByUserId: actorUserId } } } : {}), }, include: { availability: latestAvailabilityInclude } });
    await writeAuditLog({ eventId, actorUserId, action: "MERCHANDISE_VARIANT_CREATED", entityType: "MerchandiseProductVariant", entityId: variant.id, summary: `Created merchandise variant ${variant.label}.`, metadata: { after: { label: variant.label, sku: variant.sku, isEnabled: variant.isEnabled, isArchived: variant.isArchived, position: variant.position, availability: auditAvailabilitySnapshot(variant.availability[0]) } } }, tx);
    return { id: variant.id, label: variant.label, sku: variant.sku, isEnabled: variant.isEnabled, isArchived: variant.isArchived, position: variant.position, availability: projectAvailability(variant.availability[0]) };
  });
}

export async function updateVariant(eventId: string, productId: string, variantId: string, raw: unknown, actorUserId: string) {
  const input = variantInputSchema.parse(raw);
  return getPrisma().$transaction(async (tx) => {
    const before = await tx.merchandiseProductVariant.findFirst({ where: { id: variantId, productId, product: { eventId } }, include: { availability: latestAvailabilityInclude } });
    if (!before) throw new MerchandiseCatalogOperationError("VARIANT_NOT_FOUND", "The variant does not belong to this product.");
    const nextVersion = input.availability ? await nextVersionNumber(tx, variantId) : undefined;
    const availabilityData = input.availability ? {
      updateMany: { where: { isActive: true }, data: { isActive: false } },
      create: { versionNumber: nextVersion!, priceCents: input.availability.priceCents, taxTreatment: input.availability.taxTreatment, feePolicy: input.availability.feePolicy, inventoryPolicy: input.availability.inventoryPolicy, inventoryQuantity: input.availability.inventoryQuantity, salesStartsAt: input.availability.salesStartsAt ? new Date(input.availability.salesStartsAt) : null, salesEndsAt: input.availability.salesEndsAt ? new Date(input.availability.salesEndsAt) : null, minQuantity: input.availability.minQuantity, maxQuantity: input.availability.maxQuantity, attendeeAvailability: input.availability.attendeeAvailability, isActive: input.availability.isActive && input.isEnabled && !input.isArchived, reason: input.availability.reason, createdByUserId: actorUserId },
    } : (input.isEnabled && !input.isArchived ? undefined : { updateMany: { where: { isActive: true }, data: { isActive: false } } });
    const variant = await tx.merchandiseProductVariant.update({ where: { id: variantId }, data: { label: input.label, sku: input.sku ?? null, isEnabled: input.isEnabled, isArchived: input.isArchived, position: input.position, ...(availabilityData ? { availability: availabilityData } : {}) }, include: { availability: latestAvailabilityInclude } });
    await writeAuditLog({ eventId, actorUserId, action: variant.isArchived ? "MERCHANDISE_VARIANT_ARCHIVED" : "MERCHANDISE_VARIANT_UPDATED", entityType: "MerchandiseProductVariant", entityId: variant.id, summary: `Updated merchandise variant ${variant.label}.`, metadata: { before: { label: before.label, sku: before.sku, isEnabled: before.isEnabled, isArchived: before.isArchived, position: before.position, availability: auditAvailabilitySnapshot(before.availability[0]) }, after: { label: variant.label, sku: variant.sku, isEnabled: variant.isEnabled, isArchived: variant.isArchived, position: variant.position, availability: auditAvailabilitySnapshot(variant.availability[0]) } } }, tx);
    return { id: variant.id, label: variant.label, sku: variant.sku, isEnabled: variant.isEnabled, isArchived: variant.isArchived, position: variant.position, availability: projectAvailability(variant.availability[0]) };
  });
}

export async function archiveVariant(eventId: string, productId: string, variantId: string, actorUserId: string) {
  return getPrisma().$transaction(async (tx) => {
    const before = await tx.merchandiseProductVariant.findFirst({ where: { id: variantId, productId, product: { eventId } }, include: { availability: latestAvailabilityInclude } });
    if (!before) throw new MerchandiseCatalogOperationError("VARIANT_NOT_FOUND", "The variant does not belong to this product.");
    const variant = await tx.merchandiseProductVariant.update({ where: { id: variantId }, data: { isEnabled: false, isArchived: true, availability: { updateMany: { where: { isActive: true }, data: { isActive: false } } } }, include: { availability: latestAvailabilityInclude } });
    await writeAuditLog({ eventId, actorUserId, action: "MERCHANDISE_VARIANT_ARCHIVED", entityType: "MerchandiseProductVariant", entityId: variant.id, summary: `Archived merchandise variant ${variant.label}.`, metadata: { before: { isEnabled: before.isEnabled, isArchived: before.isArchived, position: before.position, availability: auditAvailabilitySnapshot(before.availability[0]) }, after: { isEnabled: false, isArchived: true, position: variant.position, availability: auditAvailabilitySnapshot(variant.availability[0]) } } }, tx);
    return { id: variant.id, label: variant.label, sku: variant.sku, isEnabled: variant.isEnabled, isArchived: variant.isArchived, position: variant.position, availability: projectAvailability(variant.availability[0]) };
  });
}

export type { MerchandiseProjectionInput };
