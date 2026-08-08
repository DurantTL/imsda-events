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
    }, "2026-08-08T12:00:00.000Z");

    expect(result).toEqual({
      eventId: "event_1",
      products: [expect.objectContaining({
        id: "product_1",
        artwork: { assetId: "asset_1", altText: "Blue camp shirt" },
        variants: [expect.objectContaining({
          id: "variant_1",
          availability: expect.objectContaining({ priceCents: 2500 }),
        })],
      })],
    });
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
    }, "2026-08-08T12:00:00.000Z");
    expect(result.products).toEqual([]);
  });
});
