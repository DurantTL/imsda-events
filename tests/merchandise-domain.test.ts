import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildMerchandiseOrderDraft,
  merchandiseOrderFingerprint,
  replayMerchandiseOrder,
  visibleMerchandiseCatalog,
  type MerchandiseCatalog,
  type MerchandiseOrderRequest,
} from "@/modules/merchandise/domain";

function catalog(): MerchandiseCatalog {
  return {
    eventId: "event-1",
    isPublished: true,
    products: [{
      id: "product-1",
      eventId: "event-1",
      name: "Retreat shirt",
      isEnabled: true,
      variants: [{
        id: "variant-1",
        label: "Medium",
        isEnabled: true,
        availability: {
          id: "availability-1",
          priceCents: 2_500,
          taxTreatment: "TAXABLE",
          feePolicy: "PASSED_TO_BUYER",
          inventoryPolicy: "TRACKED",
          inventoryQuantity: 20,
          isActive: true,
        },
      }],
    }],
  };
}

function request(): MerchandiseOrderRequest {
  return {
    eventId: "event-1",
    registrationId: "registration-1",
    purchaserSnapshot: {
      email: "buyer@example.test",
      name: "Synthetic Buyer",
    },
    clientRequestId: "request-1",
    feeCents: 100,
    taxCents: 150,
    lines: [{ variantId: "variant-1", quantity: 2 }],
  };
}

describe("merchandise catalog visibility", () => {
  it("shows enabled event-owned variants only for published events", () => {
    const fixture = catalog();

    expect(visibleMerchandiseCatalog(fixture)).toHaveLength(1);

    fixture.isPublished = false;
    expect(visibleMerchandiseCatalog(fixture)).toEqual([]);

    fixture.isPublished = true;
    fixture.products[0]!.eventId = "another-event";
    expect(visibleMerchandiseCatalog(fixture)).toEqual([]);
  });

  it("rejects disabled or deleted variants for a new order", () => {
    const disabled = catalog();
    disabled.products[0]!.variants[0]!.isEnabled = false;
    expect(() => buildMerchandiseOrderDraft(request(), disabled))
      .toThrowError(expect.objectContaining({ code: "VARIANT_UNAVAILABLE" }));

    const deleted = catalog();
    deleted.products[0]!.variants = [];
    expect(() => buildMerchandiseOrderDraft(request(), deleted))
      .toThrowError(expect.objectContaining({ code: "VARIANT_UNAVAILABLE" }));
  });
});

describe("immutable merchandise order snapshots", () => {
  it("preserves commercial facts after catalog changes", () => {
    const fixture = catalog();
    const draft = buildMerchandiseOrderDraft(request(), fixture);
    const originalSnapshot = structuredClone(draft);

    fixture.products[0]!.name = "Renamed shirt";
    const variant = fixture.products[0]!.variants[0]!;
    variant.label = "Renamed size";
    variant.availability!.priceCents = 9_999;
    variant.availability!.taxTreatment = "TAX_EXEMPT";
    variant.availability!.feePolicy = "ABSORBED_BY_EVENT";
    variant.isEnabled = false;

    expect(draft).toEqual(originalSnapshot);
    expect(draft).toMatchObject({
      registrationId: "registration-1",
      subtotalCents: 5_000,
      feeCents: 100,
      taxCents: 150,
      totalCents: 5_250,
      lines: [{
        eventId: "event-1",
        productNameSnapshot: "Retreat shirt",
        variantLabelSnapshot: "Medium",
        unitPriceCentsSnapshot: 2_500,
        quantity: 2,
        taxTreatmentSnapshot: "TAXABLE",
        feePolicySnapshot: "PASSED_TO_BUYER",
        lineTotalCents: 5_000,
      }],
    });
  });

  it("keeps a purchased snapshot after its catalog variant is deleted", () => {
    const fixture = catalog();
    const draft = buildMerchandiseOrderDraft(request(), fixture);

    fixture.products[0]!.variants = [];

    expect(draft.lines[0]).toMatchObject({
      productId: "product-1",
      variantId: "variant-1",
      availabilityId: "availability-1",
      productNameSnapshot: "Retreat shirt",
      variantLabelSnapshot: "Medium",
    });
  });
});

describe("merchandise order retry safety", () => {
  it("replays the same request and rejects a changed basket", () => {
    const firstRequest = request();
    const existing = {
      id: "order-1",
      requestFingerprint: merchandiseOrderFingerprint(firstRequest),
    };
    const reorderedSnapshot = {
      ...request(),
      purchaserSnapshot: {
        name: "Synthetic Buyer",
        email: "buyer@example.test",
      },
    };

    expect(replayMerchandiseOrder(existing, reorderedSnapshot)).toBe(existing);
    expect(() => replayMerchandiseOrder(existing, {
      ...request(),
      lines: [{ variantId: "variant-1", quantity: 3 }],
    })).toThrowError(expect.objectContaining({
      code: "IDEMPOTENCY_KEY_REUSED",
    }));
  });

  it("rejects duplicate variant lines before an order can be persisted", () => {
    expect(() => buildMerchandiseOrderDraft({
      ...request(),
      lines: [
        { variantId: "variant-1", quantity: 1 },
        { variantId: "variant-1", quantity: 1 },
      ],
    }, catalog())).toThrowError(expect.objectContaining({
      code: "DUPLICATE_VARIANT",
    }));
  });
});

describe("merchandise ledger database contract", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const migration = readFileSync(
    "prisma/migrations/20260808120000_merchandise_ledger/migration.sql",
    "utf8",
  );
  const guidance = readFileSync(
    "docs/MERCHANDISE-LEDGER-MIGRATION.md",
    "utf8",
  );

  it("keeps merchandise obligations separate and retry-safe", () => {
    expect(schema).toContain("model MerchandiseOrder");
    expect(schema).toContain("requestFingerprint String");
    expect(schema).toContain("@@unique([eventId, clientRequestId])");
    expect(schema).toContain("subtotalCents");
    expect(schema).toContain("registrationId    String?");
    expect(migration).toContain(
      'UNIQUE ("eventId", "clientRequestId")',
    );
  });

  it("enforces one effective availability and valid inventory quantities", () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "MerchandiseVariantAvailability_one_active_per_variant"',
    );
    expect(migration).toContain('WHERE "isActive" = true');
    expect(migration).toContain(
      '"MerchandiseVariantAvailability_inventory_check"',
    );
  });

  it("documents safe rollback and forward-fix handling", () => {
    expect(guidance).toContain("Rollback");
    expect(guidance).toContain("Forward fix");
    expect(guidance).toContain("Do not drop");
  });
});
