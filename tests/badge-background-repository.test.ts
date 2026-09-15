import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import {
  BadgeBackgroundError,
  getEventBadgeBackground,
  listBadgeBackgroundOptions,
  setEventBadgeBackground,
} from "@/modules/checkin/badge-background-repository";

function prismaClient() {
  const tx = {
    event: { update: vi.fn().mockResolvedValue({}) },
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
      event: { findUnique: vi.fn().mockResolvedValue(null) },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("badge background", () => {
  it("offers only image files as background options", async () => {
    const { client } = prismaClient();
    client.eventAsset.findMany.mockResolvedValue([{
      id: "asset-1",
      displayName: "retreat-badge.png",
      contentType: "image/png",
      byteSize: 240_000,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    }]);
    dependencies.getPrisma.mockReturnValue(client);

    const options = await listBadgeBackgroundOptions("event-1");

    expect(client.eventAsset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { eventId: "event-1", contentType: { startsWith: "image/" } },
      }),
    );
    expect(options[0].url).toContain("/assets/asset-1");
  });

  it("refuses a PDF as badge artwork", async () => {
    const { client } = prismaClient();
    client.eventAsset.findFirst.mockResolvedValue({
      id: "asset-2",
      displayName: "schedule.pdf",
      contentType: "application/pdf",
    });
    dependencies.getPrisma.mockReturnValue(client);

    await expect(setEventBadgeBackground("event-1", "asset-2", "user-1"))
      .rejects.toBeInstanceOf(BadgeBackgroundError);
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a file belonging to another event", async () => {
    const { client } = prismaClient();
    client.eventAsset.findFirst.mockResolvedValue(null);
    dependencies.getPrisma.mockReturnValue(client);

    await expect(setEventBadgeBackground("event-1", "asset-9", "user-1"))
      .rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
  });

  it("stores the choice and records it in the audit log", async () => {
    const { client, tx } = prismaClient();
    client.eventAsset.findFirst.mockResolvedValue({
      id: "asset-1",
      displayName: "retreat-badge.png",
      contentType: "image/png",
    });
    client.event.findUnique.mockResolvedValue({
      badgeBackgroundAssetId: "asset-1",
      badgeBackground: {
        id: "asset-1",
        displayName: "retreat-badge.png",
        contentType: "image/png",
        storageKey: "event-1/asset-1.png",
      },
    });
    dependencies.getPrisma.mockReturnValue(client);

    const background = await setEventBadgeBackground("event-1", "asset-1", "user-1");

    expect(tx.event.update).toHaveBeenCalledWith({
      where: { id: "event-1" },
      data: { badgeBackgroundAssetId: "asset-1" },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "EVENT_BADGE_BACKGROUND_SET" }),
    }));
    expect(background?.url).toBe("/api/events/event-1/badge-background");
  });

  it("clears the background without checking any file", async () => {
    const { client, tx } = prismaClient();
    dependencies.getPrisma.mockReturnValue(client);

    const background = await setEventBadgeBackground("event-1", null, "user-1");

    expect(client.eventAsset.findFirst).not.toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "EVENT_BADGE_BACKGROUND_CLEARED" }),
    }));
    expect(background).toBeNull();
  });

  it("reports no background when an event has none", async () => {
    const { client } = prismaClient();
    client.event.findUnique.mockResolvedValue({
      badgeBackgroundAssetId: null,
      badgeBackground: null,
    });
    dependencies.getPrisma.mockReturnValue(client);

    expect(await getEventBadgeBackground("event-1")).toBeNull();
  });
});

describe("badge background migration", () => {
  it("restricts deletion of the file an event prints badges from", async () => {
    const { readFileSync } = await import("node:fs");
    const migration = readFileSync(
      new URL(
        "../prisma/migrations/20260915120000_event_badge_background/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toContain('ADD COLUMN "badgeBackgroundAssetId" TEXT');
    expect(migration).toContain("ON DELETE RESTRICT ON UPDATE CASCADE");
    expect(migration).not.toContain("ON DELETE SET NULL");
  });
});
