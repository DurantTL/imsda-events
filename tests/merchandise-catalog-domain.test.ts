import { describe, expect, it } from "vitest";
import {
  MerchandiseCatalogError,
  merchandiseCatalogInputSchema,
  projectMerchandiseCatalog,
  validateArtworkLink,
} from "@/modules/merchandise/catalog-domain";

describe("merchandise catalog domain", () => {
  it("projects only enabled, approved, in-window variants for public use", () => {
    const result = projectMerchandiseCatalog({
      eventId: "event_1",
      status: "APPROVED",
      isEnabled: true,
      products: [{
        id: "product_1",
        eventId: "event_1",
        name: "Camp shirt",
        description: "Cotton",
        isEnabled: true,
        isArchived: false,
        position: 0,
        artwork: { assetId: "asset_1", altText: "Blue camp shirt" },
        variants: [{
          id: "variant_1",
          label: "Medium",
          sku: "SHIRT-M",
          isEnabled: true,
          isArchived: false,
          availability: {
            id: "availability_1",
            priceCents: 2500,
            taxTreatment: "TAXABLE",
            feePolicy: "ABSORBED_BY_EVENT",
            inventoryPolicy: "UNLIMITED",
            inventoryQuantity: null,
            minQuantity: 1,
            maxQuantity: 3,
            attendeeAvailability: "ALL",
            salesStartsAt: null,
            salesEndsAt: "2026-12-31T23:59:59.000Z",
            isActive: true,
          },
        }],
      }],
    }, {}, "2026-08-08T12:00:00.000Z");

    expect(result).toEqual({
      eventId: "event_1",
      products: [{
        id: "product_1",
        name: "Camp shirt",
        description: "Cotton",
        artwork: { assetId: "asset_1", altText: "Blue camp shirt" },
        variants: [{
          id: "variant_1",
          label: "Medium",
          availability: expect.objectContaining({ priceCents: 2500 }),
        }],
      }],
    });
  });

  it("never exposes admin-only or repository-internal fields in the public DTO", () => {
    const result = projectMerchandiseCatalog({
      eventId: "event_1", status: "APPROVED", isEnabled: true,
      products: [{
        id: "product_1", eventId: "event_1", name: "Camp shirt", description: null, isEnabled: true, isArchived: false, position: 0, artwork: null,
        variants: [{
          id: "variant_1", label: "Medium", sku: "SHIRT-M", isEnabled: true, isArchived: false,
          availability: { id: "availability_1", priceCents: 2500, taxTreatment: "TAXABLE", feePolicy: "ABSORBED_BY_EVENT", inventoryPolicy: "UNLIMITED", inventoryQuantity: null, minQuantity: 1, maxQuantity: null, attendeeAvailability: "ALL", salesStartsAt: null, salesEndsAt: null, isActive: true },
        }],
      }],
    });
    const product = result.products[0] as Record<string, unknown>;
    expect(product).not.toHaveProperty("isEnabled");
    expect(product).not.toHaveProperty("isArchived");
    expect(product).not.toHaveProperty("position");
    const variant = (product.variants as Array<Record<string, unknown>>)[0];
    expect(variant).not.toHaveProperty("sku");
    expect(variant).not.toHaveProperty("isEnabled");
    expect(variant).not.toHaveProperty("isArchived");
    const availability = variant.availability as Record<string, unknown>;
    expect(availability).not.toHaveProperty("id");
    expect(availability).not.toHaveProperty("attendeeAvailability");
    expect(availability).not.toHaveProperty("isActive");
  });

  it("enforces attendeeAvailability per viewer", () => {
    const catalog = {
      eventId: "event_1", status: "APPROVED" as const, isEnabled: true,
      products: [{
        id: "product_1", eventId: "event_1", name: "Camp shirt", description: null, isEnabled: true, isArchived: false, position: 0, artwork: null,
        variants: [
          { id: "v_all", label: "All", sku: null, isEnabled: true, isArchived: false, availability: { id: "a1", priceCents: 100, taxTreatment: "TAXABLE" as const, feePolicy: "ABSORBED_BY_EVENT" as const, inventoryPolicy: "UNLIMITED" as const, inventoryQuantity: null, minQuantity: 1, maxQuantity: null, attendeeAvailability: "ALL", salesStartsAt: null, salesEndsAt: null, isActive: true } },
          { id: "v_reg", label: "Registered", sku: null, isEnabled: true, isArchived: false, availability: { id: "a2", priceCents: 200, taxTreatment: "TAXABLE" as const, feePolicy: "ABSORBED_BY_EVENT" as const, inventoryPolicy: "UNLIMITED" as const, inventoryQuantity: null, minQuantity: 1, maxQuantity: null, attendeeAvailability: "REGISTERED", salesStartsAt: null, salesEndsAt: null, isActive: true } },
          { id: "v_staff", label: "Staff", sku: null, isEnabled: true, isArchived: false, availability: { id: "a3", priceCents: 300, taxTreatment: "TAXABLE" as const, feePolicy: "ABSORBED_BY_EVENT" as const, inventoryPolicy: "UNLIMITED" as const, inventoryQuantity: null, minQuantity: 1, maxQuantity: null, attendeeAvailability: "STAFF_ONLY", salesStartsAt: null, salesEndsAt: null, isActive: true } },
        ],
      }],
    };
    expect(projectMerchandiseCatalog(catalog, {}).products[0].variants.map((v) => v.id)).toEqual(["v_all"]);
    expect(projectMerchandiseCatalog(catalog, { isRegisteredAttendee: true }).products[0].variants.map((v) => v.id)).toEqual(["v_all", "v_reg"]);
    expect(projectMerchandiseCatalog(catalog, { isStaff: true }).products[0].variants.map((v) => v.id)).toEqual(["v_all", "v_reg", "v_staff"]);
  });

  it("keeps configuration changes behind explicit approval", () => {
    expect(() => merchandiseCatalogInputSchema.parse({
      isEnabled: true,
      status: "APPROVED",
    })).toThrow();
    expect(merchandiseCatalogInputSchema.parse({
      isEnabled: true,
      status: "DRAFT",
    })).toEqual({ isEnabled: true, status: "DRAFT" });
  });

  it("requires a verified asset reference and meaningful alt text", () => {
    expect(() => validateArtworkLink({ assetId: "asset_1", altText: "   " }))
      .toThrow(MerchandiseCatalogError);
    expect(validateArtworkLink({ assetId: "asset_1", altText: "A blue shirt" }))
      .toEqual({ assetId: "asset_1", altText: "A blue shirt" });
  });

  it("hides a draft or disabled catalog by default, matching the live public gate", () => {
    const draftCatalog = {
      eventId: "event_1", status: "DRAFT" as const, isEnabled: false,
      products: [{
        id: "product_1", eventId: "event_1", name: "Camp shirt", description: null, isEnabled: true, isArchived: false, position: 0, artwork: null,
        variants: [{ id: "v1", label: "Medium", sku: null, isEnabled: true, isArchived: false, availability: { id: "a1", priceCents: 100, taxTreatment: "TAXABLE" as const, feePolicy: "ABSORBED_BY_EVENT" as const, inventoryPolicy: "UNLIMITED" as const, inventoryQuantity: null, minQuantity: 1, maxQuantity: null, attendeeAvailability: "ALL", salesStartsAt: null, salesEndsAt: null, isActive: true } }],
      }],
    };
    expect(projectMerchandiseCatalog(draftCatalog).products).toEqual([]);
  });

  it("lets a staff preview bypass the draft/approval gate without weakening the per-variant safety rules", () => {
    const draftCatalog = {
      eventId: "event_1", status: "DRAFT" as const, isEnabled: false,
      products: [{
        id: "product_1", eventId: "event_1", name: "Camp shirt", description: null, isEnabled: true, isArchived: false, position: 0, artwork: null,
        variants: [
          { id: "visible", label: "Medium", sku: null, isEnabled: true, isArchived: false, availability: { id: "a1", priceCents: 100, taxTreatment: "TAXABLE" as const, feePolicy: "ABSORBED_BY_EVENT" as const, inventoryPolicy: "UNLIMITED" as const, inventoryQuantity: null, minQuantity: 1, maxQuantity: null, attendeeAvailability: "ALL", salesStartsAt: null, salesEndsAt: null, isActive: true } },
          { id: "disabled", label: "Paused", sku: null, isEnabled: false, isArchived: false, availability: { id: "a2", priceCents: 200, taxTreatment: "TAXABLE" as const, feePolicy: "ABSORBED_BY_EVENT" as const, inventoryPolicy: "UNLIMITED" as const, inventoryQuantity: null, minQuantity: 1, maxQuantity: null, attendeeAvailability: "ALL", salesStartsAt: null, salesEndsAt: null, isActive: true } },
        ],
      }],
    };

    const bypassed = projectMerchandiseCatalog(draftCatalog, {}, undefined, { bypassPublicationGate: true });

    expect(bypassed.products[0]?.variants.map((v) => v.id)).toEqual(["visible"]);
  });

  it("never lets the staff-preview bypass leak into a call that omits it", () => {
    const draftCatalog = {
      eventId: "event_1", status: "PENDING_APPROVAL" as const, isEnabled: true,
      products: [{
        id: "product_1", eventId: "event_1", name: "Camp shirt", description: null, isEnabled: true, isArchived: false, position: 0, artwork: null,
        variants: [{ id: "v1", label: "Medium", sku: null, isEnabled: true, isArchived: false, availability: { id: "a1", priceCents: 100, taxTreatment: "TAXABLE" as const, feePolicy: "ABSORBED_BY_EVENT" as const, inventoryPolicy: "UNLIMITED" as const, inventoryQuantity: null, minQuantity: 1, maxQuantity: null, attendeeAvailability: "ALL", salesStartsAt: null, salesEndsAt: null, isActive: true } }],
      }],
    };
    expect(projectMerchandiseCatalog(draftCatalog, {}, undefined, {}).products).toEqual([]);
    expect(projectMerchandiseCatalog(draftCatalog, {}, undefined, { bypassPublicationGate: false }).products).toEqual([]);
  });

  it("hides archived products, disabled variants, and expired availability from public projection", () => {
    const result = projectMerchandiseCatalog({
      eventId: "event_1", status: "APPROVED", isEnabled: true,
      products: [
        { id: "archived", eventId: "event_1", name: "Old", description: null, isEnabled: true, isArchived: true, position: 0, artwork: null, variants: [] },
        { id: "current", eventId: "event_1", name: "Current", description: null, isEnabled: true, isArchived: false, position: 1, artwork: null, variants: [
          { id: "disabled", label: "Disabled", sku: null, isEnabled: false, isArchived: false, availability: { id: "a", priceCents: 1, taxTreatment: "TAXABLE", feePolicy: "ABSORBED_BY_EVENT", inventoryPolicy: "UNLIMITED", inventoryQuantity: null, minQuantity: 1, maxQuantity: null, attendeeAvailability: "ALL", salesStartsAt: null, salesEndsAt: null, isActive: true } },
          { id: "expired", label: "Expired", sku: null, isEnabled: true, isArchived: false, availability: { id: "b", priceCents: 1, taxTreatment: "TAXABLE", feePolicy: "ABSORBED_BY_EVENT", inventoryPolicy: "UNLIMITED", inventoryQuantity: null, minQuantity: 1, maxQuantity: null, attendeeAvailability: "ALL", salesStartsAt: null, salesEndsAt: "2026-01-01T00:00:00.000Z", isActive: true } },
        ] },
      ],
    }, {}, "2026-08-08T12:00:00.000Z");
    expect(result.products).toEqual([]);
  });
});
