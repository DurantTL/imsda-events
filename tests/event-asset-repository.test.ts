import { describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import { findPublishedEventAsset } from "@/modules/events/asset-repository";

describe("findPublishedEventAsset", () => {
  it("reaches an asset through the approved-merchandise-artwork path, not only a published section link", async () => {
    const findFirst = vi.fn().mockResolvedValue({ displayName: "shirt.png", contentType: "image/png", storageKey: "key_1" });
    dependencies.getPrisma.mockReturnValue({ eventAsset: { findFirst } });

    await findPublishedEventAsset("asset_1");

    const query = findFirst.mock.calls[0][0] as { where: { event: { isPublished: boolean }; OR: Array<Record<string, unknown>> } };
    expect(query.where.event).toEqual({ isPublished: true });
    const merchandiseBranch = query.where.OR.find((clause) => "merchandiseArtworkProducts" in clause) as {
      merchandiseArtworkProducts: { some: { isEnabled: boolean; isArchived: boolean; event: { merchandiseCatalog: { isEnabled: boolean; status: string } } } };
    };
    expect(merchandiseBranch).toBeDefined();
    expect(merchandiseBranch.merchandiseArtworkProducts.some).toMatchObject({
      isEnabled: true,
      isArchived: false,
      event: { merchandiseCatalog: { isEnabled: true, status: "APPROVED" } },
    });
    const sectionBranch = query.where.OR.find((clause) => "links" in clause);
    expect(sectionBranch).toBeDefined();
  });
});
