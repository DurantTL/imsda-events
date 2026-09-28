import { beforeEach, describe, expect, it, vi } from "vitest";

import { Prisma } from "@prisma/client";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn(), deleteAsset: vi.fn(), logError: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/lib/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logger")>();
  return { ...actual, logError: dependencies.logError };
});
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
    eventAsset: { findFirst: vi.fn(), delete: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  return {
    tx,
    client: {
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
      eventAsset: {
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
    const query = client.eventAsset.findMany.mock.calls[0][0] as { select: { links: { where: unknown } } };
    expect(query.select.links.where).toEqual({ section: { eventId: "event-1" } });
    expect(assets[1].usage).toEqual({
      publishedSectionTitles: ["Weekend schedule"],
      draftSectionTitles: ["Retreat resources"],
      isBadgeBackground: true,
    });
  });
});

function draftOrPublished(id: string, title: string, isPublished: boolean, linkCount: number) {
  return { id, kind: "RESOURCE_LINKS", title, isPublished, _count: { links: linkCount } };
}

function unusedAsset() {
  return {
    id: "asset-1",
    displayName: "flyer.pdf",
    storageKey: "event-1/flyer.pdf",
    links: [] as Array<{ id: string; section: ReturnType<typeof draftOrPublished> }>,
    badgeBackgroundEvents: [] as Array<{ id: string }>,
    _count: { merchandiseArtworkProducts: 0 },
  };
}

describe("removeEventAsset", () => {
  it("deletes an unused file, removes its stored bytes, and writes an audit entry", async () => {
    const { client, tx } = prismaClient();
    tx.eventAsset.findFirst.mockResolvedValue({
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
    const { client, tx } = prismaClient();
    tx.eventAsset.findFirst.mockResolvedValue({
      id: "asset-1",
      displayName: "schedule.pdf",
      storageKey: "event-1/schedule.pdf",
      links: [{ id: "link-1", section: draftOrPublished("section-1", "Weekend schedule", true, 1) }],
      badgeBackgroundEvents: [],
      _count: { merchandiseArtworkProducts: 0 },
    });
    dependencies.getPrisma.mockReturnValue(client);

    const attempt = removeEventAsset("event-1", "asset-1", "user-1");

    await expect(attempt).rejects.toBeInstanceOf(EventAssetError);
    await expect(attempt).rejects.toMatchObject({ code: "ASSET_IN_USE" });
    await expect(attempt).rejects.toMatchObject({ message: expect.stringContaining("Weekend schedule") });
    expect(tx.eventAsset.delete).not.toHaveBeenCalled();
    expect(dependencies.deleteAsset).not.toHaveBeenCalled();
  });

  it("blocks deleting the event's active badge background, naming that use", async () => {
    const { client, tx } = prismaClient();
    tx.eventAsset.findFirst.mockResolvedValue({
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

  it("looks the file up inside the transaction, scoped to this event", async () => {
    const { client, tx } = prismaClient();
    tx.eventAsset.findFirst.mockResolvedValue(unusedAsset());
    dependencies.getPrisma.mockReturnValue(client);

    await removeEventAsset("event-1", "asset-1", "user-1");

    expect(client.$transaction).toHaveBeenCalledTimes(1);
    const query = tx.eventAsset.findFirst.mock.calls[0][0] as {
      where: Record<string, unknown>;
      select: { links: { where: unknown } };
    };
    expect(query.where).toEqual({ id: "asset-1", eventId: "event-1" });
    expect(query.select.links.where).toEqual({ section: { eventId: "event-1" } });
  });

  it("blocks deleting merchandise artwork", async () => {
    const { client, tx } = prismaClient();
    tx.eventAsset.findFirst.mockResolvedValue({
      ...unusedAsset(),
      _count: { merchandiseArtworkProducts: 2 },
    });
    dependencies.getPrisma.mockReturnValue(client);

    await expect(removeEventAsset("event-1", "asset-1", "user-1")).rejects.toMatchObject({
      code: "ASSET_IN_USE",
      message: expect.stringContaining("merchandise"),
    });
    expect(tx.eventAsset.delete).not.toHaveBeenCalled();
    expect(dependencies.deleteAsset).not.toHaveBeenCalled();
  });

  it("blocks deleting a file that is the only link in a draft section, naming that section", async () => {
    const { client, tx } = prismaClient();
    tx.eventAsset.findFirst.mockResolvedValue({
      ...unusedAsset(),
      links: [{ id: "link-draft", section: draftOrPublished("section-draft", "Retreat resources", false, 1) }],
    });
    dependencies.getPrisma.mockReturnValue(client);

    const attempt = removeEventAsset("event-1", "asset-1", "user-1");

    await expect(attempt).rejects.toMatchObject({
      code: "ASSET_IN_USE",
      message: expect.stringContaining('Remove it from the draft section "Retreat resources" and save first, or add another link there'),
    });
    expect(tx.eventContentLink.deleteMany).not.toHaveBeenCalled();
    expect(tx.eventAsset.delete).not.toHaveBeenCalled();
    expect(dependencies.deleteAsset).not.toHaveBeenCalled();
  });

  it("removes only this file's tile from a draft section that has other links", async () => {
    const { client, tx } = prismaClient();
    tx.eventAsset.findFirst.mockResolvedValue({
      ...unusedAsset(),
      displayName: "draft-notes.pdf",
      storageKey: "event-1/draft-notes.pdf",
      links: [{ id: "link-draft", section: draftOrPublished("section-draft", "Retreat resources", false, 3) }],
    });
    dependencies.getPrisma.mockReturnValue(client);

    const result = await removeEventAsset("event-1", "asset-1", "user-1");

    expect(tx.eventContentLink.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["link-draft"] } } });
    expect(tx.eventAsset.delete).toHaveBeenCalledWith({ where: { id: "asset-1" } });
    expect(result).toEqual({ removedFromDraftSectionTitles: ["Retreat resources"] });
    expect(dependencies.deleteAsset).toHaveBeenCalledWith("event-1/draft-notes.pdf");
  });

  it("reports a tile linked concurrently (foreign key restrict) as in use, not a generic failure", async () => {
    const { client, tx } = prismaClient();
    tx.eventAsset.findFirst.mockResolvedValue(unusedAsset());
    tx.eventAsset.delete.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("Foreign key constraint failed", {
      code: "P2003",
      clientVersion: "test",
    }));
    dependencies.getPrisma.mockReturnValue(client);

    await expect(removeEventAsset("event-1", "asset-1", "user-1")).rejects.toMatchObject({
      code: "ASSET_IN_USE",
      message: "This file was just linked; reload and try again.",
    });
    expect(dependencies.deleteAsset).not.toHaveBeenCalled();
  });

  it("still succeeds when removing the stored copy fails after the row is gone, and logs it", async () => {
    const { client, tx } = prismaClient();
    tx.eventAsset.findFirst.mockResolvedValue(unusedAsset());
    dependencies.getPrisma.mockReturnValue(client);
    dependencies.deleteAsset.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));

    await expect(removeEventAsset("event-1", "asset-1", "user-1")).resolves.toEqual({
      removedFromDraftSectionTitles: [],
    });
    expect(dependencies.logError).toHaveBeenCalledTimes(1);
  });

  it("reports a missing file rather than deleting anything", async () => {
    const { client, tx } = prismaClient();
    tx.eventAsset.findFirst.mockResolvedValue(null);
    dependencies.getPrisma.mockReturnValue(client);

    await expect(removeEventAsset("event-1", "asset-missing", "user-1")).rejects.toMatchObject({
      code: "ASSET_NOT_FOUND",
    });
    expect(tx.eventAsset.delete).not.toHaveBeenCalled();
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
