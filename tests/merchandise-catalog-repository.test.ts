import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import {
  createProduct,
  createVariant,
  getMerchandiseCatalog,
  getMerchandiseCatalogForProjection,
  saveCatalog,
  updateVariant,
} from "@/modules/merchandise/catalog-repository";

function availabilityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "availability_1",
    versionNumber: 1,
    priceCents: 2500,
    taxTreatment: "TAXABLE",
    feePolicy: "ABSORBED_BY_EVENT",
    inventoryPolicy: "UNLIMITED",
    inventoryQuantity: null,
    minQuantity: 1,
    maxQuantity: null,
    attendeeAvailability: "ALL",
    salesStartsAt: null,
    salesEndsAt: null,
    isActive: true,
    reason: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("merchandise catalog repository", () => {
  it("forces a disabled or archived variant's availability inactive even when the payload claims it is active", async () => {
    const tx = {
      merchandiseProduct: { findFirst: vi.fn().mockResolvedValue({ id: "product_1", eventId: "event_1" }) },
      merchandiseProductVariant: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(({ data }: { data: { label: string; sku: string | null; isEnabled: boolean; isArchived: boolean; position: number; availability?: { create: Record<string, unknown> } } }) => Promise.resolve({
          id: "variant_1",
          label: data.label,
          sku: data.sku,
          isEnabled: data.isEnabled,
          isArchived: data.isArchived,
          position: data.position,
          availability: data.availability ? [availabilityRow(data.availability.create)] : [],
        })),
      },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_1" }) },
    };
    const prisma = { $transaction: vi.fn((operation: (client: typeof tx) => unknown) => operation(tx)) };
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await createVariant("event_1", "product_1", {
      label: "Disabled variant",
      isEnabled: false,
      availability: { priceCents: 1000, isActive: true },
    }, "staff_1");

    expect(tx.merchandiseProductVariant.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        availability: { create: expect.objectContaining({ isActive: false }) },
      }),
    }));
    expect(result.availability?.isActive).toBe(false);
  });

  it("assigns a new product the next position after the current highest, ignoring any position the client sent", async () => {
    const tx = {
      merchandiseProduct: {
        findFirst: vi.fn().mockResolvedValue({ position: 4 }),
        create: vi.fn().mockImplementation(({ data }: { data: { position: number } }) => Promise.resolve({
          id: "product_2", name: "Hat", description: null, isEnabled: true, isArchived: false, position: data.position,
          updatedAt: new Date("2026-08-08T00:00:00.000Z"), artworkAssetId: null, artworkAltText: null, variants: [],
        })),
      },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_1" }) },
    };
    const prisma = { $transaction: vi.fn((operation: (client: typeof tx) => unknown) => operation(tx)) };
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await createProduct("event_1", { name: "Hat", position: 0 }, "staff_1");

    expect(tx.merchandiseProduct.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { eventId: "event_1" },
      orderBy: { position: "desc" },
    }));
    expect(tx.merchandiseProduct.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ position: 5 }),
    }));
    expect(result.position).toBe(5);
  });

  it("assigns the first product in an event position 0", async () => {
    const tx = {
      merchandiseProduct: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(({ data }: { data: { position: number } }) => Promise.resolve({
          id: "product_1", name: "Shirt", description: null, isEnabled: true, isArchived: false, position: data.position,
          updatedAt: new Date("2026-08-08T00:00:00.000Z"), artworkAssetId: null, artworkAltText: null, variants: [],
        })),
      },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_1" }) },
    };
    const prisma = { $transaction: vi.fn((operation: (client: typeof tx) => unknown) => operation(tx)) };
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await createProduct("event_1", { name: "Shirt", position: 0 }, "staff_1");

    expect(result.position).toBe(0);
  });

  it("assigns a new variant the next position after its product's current highest, ignoring any position the client sent", async () => {
    const tx = {
      merchandiseProduct: { findFirst: vi.fn().mockResolvedValue({ id: "product_1", eventId: "event_1" }) },
      merchandiseProductVariant: {
        findFirst: vi.fn().mockResolvedValue({ position: 2 }),
        create: vi.fn().mockImplementation(({ data }: { data: { label: string; position: number } }) => Promise.resolve({
          id: "variant_2", label: data.label, sku: null, isEnabled: true, isArchived: false, position: data.position, availability: [],
        })),
      },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_1" }) },
    };
    const prisma = { $transaction: vi.fn((operation: (client: typeof tx) => unknown) => operation(tx)) };
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await createVariant("event_1", "product_1", { label: "Adult · Navy", position: 0, availability: { priceCents: 1500 } }, "staff_1");

    expect(tx.merchandiseProductVariant.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { productId: "product_1" },
      orderBy: { position: "desc" },
    }));
    expect(tx.merchandiseProductVariant.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ position: 3 }),
    }));
    expect(result.position).toBe(3);
  });

  it("reads the latest availability version for admin views regardless of isActive, so a paused variant still shows its last configured price", async () => {
    const client = {
      merchandiseCatalog: {
        findUnique: vi.fn().mockResolvedValue({ isEnabled: true, status: "APPROVED", updatedAt: new Date("2026-08-08T00:00:00.000Z") }),
      },
      merchandiseProduct: {
        findMany: vi.fn().mockResolvedValue([{
          id: "product_1", eventId: "event_1", name: "Shirt", description: null, isEnabled: true, isArchived: false, position: 0,
          updatedAt: new Date("2026-08-08T00:00:00.000Z"), artworkAssetId: null, artworkAltText: null,
          variants: [{
            id: "variant_1", label: "Paused", sku: null, isEnabled: false, isArchived: false, position: 0,
            availability: [availabilityRow({ isActive: false, versionNumber: 3, priceCents: 4200 })],
          }],
        }]),
      },
    };
    dependencies.getPrisma.mockReturnValue(client);

    const catalog = await getMerchandiseCatalog("event_1");

    const queryArgs = client.merchandiseProduct.findMany.mock.calls[0][0] as {
      include: { variants: { include: { availability: Record<string, unknown> } } };
    };
    const availabilityQuery = queryArgs.include.variants.include.availability;
    expect(availabilityQuery).not.toHaveProperty("where");
    expect(availabilityQuery.orderBy).toEqual({ versionNumber: "desc" });
    expect(availabilityQuery.take).toBe(1);
    expect(catalog.products[0]?.variants[0]?.availability).toMatchObject({ priceCents: 4200, isActive: false, versionNumber: 3 });
  });

  it("preserves paused availability plus version, reason, position, and commercial fields in the audit before/after snapshot", async () => {
    const pausedBefore = availabilityRow({ isActive: false, versionNumber: 2, priceCents: 1500, reason: "Paused for restock" });
    const activeAfter = availabilityRow({ isActive: true, versionNumber: 3, priceCents: 1800, reason: "Restocked" });
    const tx = {
      merchandiseProductVariant: {
        findFirst: vi.fn().mockResolvedValue({
          id: "variant_1", label: "Shirt - M", sku: "SHIRT-M", isEnabled: false, isArchived: false, position: 2,
          availability: [pausedBefore],
        }),
        update: vi.fn().mockResolvedValue({
          id: "variant_1", label: "Shirt - M", sku: "SHIRT-M", isEnabled: true, isArchived: false, position: 2,
          availability: [activeAfter],
        }),
      },
      merchandiseVariantAvailability: { findFirst: vi.fn().mockResolvedValue({ versionNumber: 2 }) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_1" }) },
    };
    const prisma = { $transaction: vi.fn((operation: (client: typeof tx) => unknown) => operation(tx)) };
    dependencies.getPrisma.mockReturnValue(prisma);

    await updateVariant("event_1", "product_1", "variant_1", {
      label: "Shirt - M", isEnabled: true,
      availability: { priceCents: 1800, isActive: true, reason: "Restocked" },
    }, "staff_1");

    const auditCall = tx.auditLog.create.mock.calls[0][0] as { data: { metadata: { before: Record<string, unknown>; after: Record<string, unknown> } } };
    const { before, after } = auditCall.data.metadata;
    expect(before).toMatchObject({ position: 2, availability: { versionNumber: 2, priceCents: 1500, isActive: false, reason: "Paused for restock" } });
    expect(after).toMatchObject({ position: 2, availability: { versionNumber: 3, priceCents: 1800, isActive: true, reason: "Restocked" } });
  });

  it("reads the saved catalog back from the same completed transaction, never a separate connection", async () => {
    const tx = {
      merchandiseCatalog: {
        findUnique: vi.fn()
          .mockResolvedValueOnce({ id: "catalog_1", isEnabled: false, status: "DRAFT" })
          .mockResolvedValue({ id: "catalog_1", isEnabled: true, status: "DRAFT", updatedAt: new Date("2026-08-08T00:00:00.000Z") }),
        upsert: vi.fn().mockResolvedValue({ id: "catalog_1", isEnabled: true, status: "DRAFT" }),
      },
      merchandiseProduct: { findMany: vi.fn().mockResolvedValue([]) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_1" }) },
    };
    const outerFindMany = vi.fn().mockResolvedValue([{ id: "stale_product_should_never_be_read" }]);
    const prisma = {
      $transaction: vi.fn((operation: (client: typeof tx) => unknown) => operation(tx)),
      merchandiseProduct: { findMany: outerFindMany },
      merchandiseCatalog: { findUnique: vi.fn().mockResolvedValue({ id: "catalog_1", isEnabled: false, status: "DRAFT" }) },
    };
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await saveCatalog("event_1", { isEnabled: true }, "staff_1");

    expect(outerFindMany).not.toHaveBeenCalled();
    expect(tx.merchandiseProduct.findMany).toHaveBeenCalledTimes(1);
    expect(result.isEnabled).toBe(true);
    expect(result.products).toEqual([]);
  });

  it("hides catalog contents for an unpublished event by default, matching the live public gate", async () => {
    const prisma = {
      merchandiseCatalog: { findUnique: vi.fn().mockResolvedValue({ isEnabled: true, status: "APPROVED" }) },
      event: { findUnique: vi.fn().mockResolvedValue({ isPublished: false }) },
      merchandiseProduct: { findMany: vi.fn().mockResolvedValue([{ id: "p1", eventId: "event_1", name: "Shirt", description: null, isEnabled: true, isArchived: false, position: 0, artworkAssetId: null, artworkAltText: null, variants: [] }]) },
    };
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await getMerchandiseCatalogForProjection("event_1");

    expect(result).toEqual({ eventId: "event_1", isEnabled: false, status: "DRAFT", products: [] });
  });

  it("includes draft catalog contents only when a staff preview opts into includeUnpublishedEvent", async () => {
    const prisma = {
      merchandiseCatalog: { findUnique: vi.fn().mockResolvedValue({ isEnabled: false, status: "DRAFT" }) },
      event: { findUnique: vi.fn().mockResolvedValue({ isPublished: false }) },
      merchandiseProduct: { findMany: vi.fn().mockResolvedValue([{ id: "p1", eventId: "event_1", name: "Shirt", description: null, isEnabled: true, isArchived: false, position: 0, artworkAssetId: null, artworkAltText: null, variants: [] }]) },
    };
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await getMerchandiseCatalogForProjection("event_1", { includeUnpublishedEvent: true });

    expect(result.isEnabled).toBe(false);
    expect(result.status).toBe("DRAFT");
    expect(result.products).toHaveLength(1);
    expect(result.products[0]?.id).toBe("p1");
  });

  it("rejects a non-image asset as product artwork before opening a transaction", async () => {
    const transaction = vi.fn();
    const prisma = {
      eventAsset: { findFirst: vi.fn().mockResolvedValue({ id: "asset_1", contentType: "application/pdf" }) },
      $transaction: transaction,
    };
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(createProduct("event_1", {
      name: "Shirt",
      artwork: { assetId: "asset_1", altText: "A photo of the shirt" },
    }, "staff_1")).rejects.toMatchObject({ code: "ASSET_NOT_IMAGE" });
    expect(transaction).not.toHaveBeenCalled();
  });
});
