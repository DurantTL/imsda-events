import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn(), deleteAsset: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/events/asset-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/events/asset-storage")>();
  return { ...actual, deleteAsset: dependencies.deleteAsset };
});

import {
  EventAssetError,
  findPublishedEventAsset,
  listEventAssets,
  removeEventAsset,
} from "@/modules/events/asset-repository";

function prismaClient() {
  const tx = {
    eventContentLink: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    eventAsset: { delete: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  return {
    tx,
    client: {
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
      eventAsset: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.deleteAsset.mockResolvedValue(undefined);
});

describe("listEventAssets", () => {
  it("summarizes where each file is used, for staff to see before deleting", async () => {
    const { client } = prismaClient();
    client.eventAsset.findMany.mockResolvedValue([
      {
        id: "asset-unused",
        displayName: "flyer.pdf",
        contentType: "application/pdf",
        byteSize: 1024,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
        links: [],
        badgeBackgroundEvents: [],
      },
      {
        id: "asset-used",
        displayName: "schedule.pdf",
        contentType: "application/pdf",
        byteSize: 2048,
        createdAt: new Date("2026-09-02T00:00:00.000Z"),
        links: [
          { section: { title: "Weekend schedule", isPublished: true } },
          { section: { title: "Retreat resources", isPublished: false } },
        ],
        badgeBackgroundEvents: [{ id: "event-1" }],
      },
    ]);
    dependencies.getPrisma.mockReturnValue(client);

    const assets = await listEventAssets("event-1");

    expect(assets[0].usage).toEqual({
      publishedSectionTitles: [],
      draftSectionTitles: [],
      isBadgeBackground: false,
    });
    expect(assets[1].usage).toEqual({
      publishedSectionTitles: ["Weekend schedule"],
      draftSectionTitles: ["Retreat resources"],
      isBadgeBackground: true,
    });
  });
});

describe("removeEventAsset", () => {
  it("deletes an unused file, removes its stored bytes, and writes an audit entry", async () => {
    const { client, tx } = prismaClient();
    client.eventAsset.findFirst.mockResolvedValue({
      id: "asset-1",
      displayName: "flyer.pdf",
      storageKey: "event-1/flyer.pdf",
      links: [],
      badgeBackgroundEvents: [],
      _count: { merchandiseArtworkProducts: 0 },
    });
    dependencies.getPrisma.mockReturnValue(client);

    await removeEventAsset("event-1", "asset-1", "user-1");

    expect(tx.eventAsset.delete).toHaveBeenCalledWith({ where: { id: "asset-1" } });
    expect(tx.eventContentLink.deleteMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventId: "event-1",
        actorUserId: "user-1",
        action: "EVENT_ASSET_DELETED",
        entityType: "EventAsset",
        entityId: "asset-1",
      }),
    }));
    expect(dependencies.deleteAsset).toHaveBeenCalledWith("event-1/flyer.pdf");
  });

  it("blocks deleting a file a published section still links to, naming the section", async () => {
    const { client } = prismaClient();
    client.eventAsset.findFirst.mockResolvedValue({
      id: "asset-1",
      displayName: "schedule.pdf",
      storageKey: "event-1/schedule.pdf",
      links: [{ id: "link-1", section: { title: "Weekend schedule", isPublished: true } }],
      badgeBackgroundEvents: [],
      _count: { merchandiseArtworkProducts: 0 },
    });
    dependencies.getPrisma.mockReturnValue(client);

    const attempt = removeEventAsset("event-1", "asset-1", "user-1");

    await expect(attempt).rejects.toBeInstanceOf(EventAssetError);
    await expect(attempt).rejects.toMatchObject({ code: "ASSET_IN_USE" });
    await expect(attempt).rejects.toMatchObject({ message: expect.stringContaining("Weekend schedule") });
    expect(client.$transaction).not.toHaveBeenCalled();
    expect(dependencies.deleteAsset).not.toHaveBeenCalled();
  });

  it("blocks deleting the event's active badge background, naming that use", async () => {
    const { client } = prismaClient();
    client.eventAsset.findFirst.mockResolvedValue({
      id: "asset-1",
      displayName: "badge-art.png",
      storageKey: "event-1/badge-art.png",
      links: [],
      badgeBackgroundEvents: [{ id: "event-1" }],
      _count: { merchandiseArtworkProducts: 0 },
    });
    dependencies.getPrisma.mockReturnValue(client);

    await expect(removeEventAsset("event-1", "asset-1", "user-1")).rejects.toMatchObject({
      code: "ASSET_IN_USE",
      message: expect.stringContaining("badge background"),
    });
    expect(dependencies.deleteAsset).not.toHaveBeenCalled();
  });

  it("allows deleting a file only a draft section links to, clearing that tile's reference", async () => {
    const { client, tx } = prismaClient();
    client.eventAsset.findFirst.mockResolvedValue({
      id: "asset-1",
      displayName: "draft-notes.pdf",
      storageKey: "event-1/draft-notes.pdf",
      links: [{ id: "link-draft", section: { title: "Retreat resources", isPublished: false } }],
      badgeBackgroundEvents: [],
      _count: { merchandiseArtworkProducts: 0 },
    });
    dependencies.getPrisma.mockReturnValue(client);

    await removeEventAsset("event-1", "asset-1", "user-1");

    expect(tx.eventContentLink.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["link-draft"] } } });
    expect(tx.eventAsset.delete).toHaveBeenCalledWith({ where: { id: "asset-1" } });
    expect(dependencies.deleteAsset).toHaveBeenCalledWith("event-1/draft-notes.pdf");
  });

  it("reports a missing file rather than deleting anything", async () => {
    const { client } = prismaClient();
    client.eventAsset.findFirst.mockResolvedValue(null);
    dependencies.getPrisma.mockReturnValue(client);

    await expect(removeEventAsset("event-1", "asset-missing", "user-1")).rejects.toMatchObject({
      code: "ASSET_NOT_FOUND",
    });
    expect(client.$transaction).not.toHaveBeenCalled();
  });
});

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
