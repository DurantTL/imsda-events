import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import { EventContentError, replaceEventContent } from "@/modules/events/content-repository";
import type { EventContentInput } from "@/modules/events/content-schemas";

/**
 * Mocks `$transaction` the same way `tests/event-asset-repository.test.ts`
 * and `tests/event-publish-readiness-repository.test.ts` mock it for other
 * repository functions in this module: a fake `tx` client rather than a real
 * database, with `findMany` standing in for the ownership check.
 */
function mockPrisma(ownedAssetIds: string[]) {
  const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const create = vi.fn().mockResolvedValue({});
  const auditLogCreate = vi.fn().mockResolvedValue({});
  const findMany = vi.fn().mockResolvedValue(
    ownedAssetIds.map((id) => ({ id })),
  );
  const tx = {
    eventAsset: { findMany },
    eventContentSection: { deleteMany, create },
    auditLog: { create: auditLogCreate },
  };
  const listedSections = vi.fn().mockResolvedValue([]);
  const client = {
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    eventContentSection: { findMany: listedSections },
  };
  dependencies.getPrisma.mockReturnValue(client);
  return { tx, client, deleteMany, create, auditLogCreate, findMany, listedSections };
}

function linksInput(links: EventContentInput["sections"][number]["links"]): EventContentInput {
  return {
    sections: [
      {
        kind: "RESOURCE_LINKS",
        title: "Downloads",
        body: "",
        placement: "PUBLIC_PAGE",
        items: [],
        isPublished: true,
        links,
      },
    ],
  };
}

describe("replaceEventContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a save that links another event's asset, and writes nothing", async () => {
    // The asset lookup (scoped to eventId) finds nothing for "asset_from_other_event".
    const { deleteMany, create, auditLogCreate, findMany } = mockPrisma([]);
    const input = linksInput([
      { label: "Flyer", description: "", url: null, assetId: "asset_from_other_event" },
    ]);

    await expect(replaceEventContent("event_b", input, "user_1")).rejects.toThrow(
      EventContentError,
    );
    await expect(replaceEventContent("event_b", input, "user_1")).rejects.toMatchObject({
      code: "ASSET_NOT_IN_EVENT",
    });

    // Rejected inside the transaction before any write: the section delete/
    // create and the audit log never ran.
    expect(deleteMany).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ["asset_from_other_event"] }, eventId: "event_b" },
    }));
  });

  it("rejects a save mixing an own file with another event's file", async () => {
    const { deleteMany, create } = mockPrisma(["asset_own"]);
    const input = linksInput([
      { label: "Own", description: "", url: null, assetId: "asset_own" },
      { label: "Foreign", description: "", url: null, assetId: "asset_foreign" },
    ]);

    await expect(replaceEventContent("event_b", input, "user_1")).rejects.toMatchObject({
      code: "ASSET_NOT_IN_EVENT",
    });
    expect(deleteMany).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("accepts the same own file linked twice", async () => {
    const { create, findMany } = mockPrisma(["asset_own"]);
    const input = linksInput([
      { label: "First", description: "", url: null, assetId: "asset_own" },
      { label: "Again", description: "", url: null, assetId: "asset_own" },
    ]);

    await replaceEventContent("event_b", input, "user_1");
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ["asset_own"] }, eventId: "event_b" },
    }));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("maps a file deleted mid-save (foreign key) to the same 400 error", async () => {
    const { client } = mockPrisma([]);
    client.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("fk", { code: "P2003", clientVersion: "test" }),
    );
    // The re-check after the failure finds the linked file gone.
    Object.assign(client, { eventAsset: { count: vi.fn().mockResolvedValue(0) } });
    const input = linksInput([{ label: "Flyer", description: "", url: null, assetId: "asset_own" }]);

    await expect(replaceEventContent("event_b", input, "user_1")).rejects.toMatchObject({
      code: "ASSET_NOT_IN_EVENT",
    });
  });

  it("keeps any other foreign-key failure (event, audit actor) as-is", async () => {
    const fk = new Prisma.PrismaClientKnownRequestError("fk", { code: "P2003", clientVersion: "test" });
    const { client } = mockPrisma([]);
    client.$transaction.mockRejectedValue(fk);
    // Every linked file still belongs to the event, so the file isn't the cause.
    Object.assign(client, { eventAsset: { count: vi.fn().mockResolvedValue(1) } });
    const withFile = linksInput([{ label: "Flyer", description: "", url: null, assetId: "asset_own" }]);

    await expect(replaceEventContent("event_b", withFile, "user_1")).rejects.toBe(fk);
    // No file links at all: never a file problem.
    await expect(replaceEventContent("event_b", linksInput([]), "user_1")).rejects.toBe(fk);
  });

  it("saves a link to the event's own asset", async () => {
    const { create, findMany } = mockPrisma(["asset_own"]);
    const input = linksInput([
      { label: "Flyer", description: "", url: null, assetId: "asset_own" },
    ]);

    await replaceEventContent("event_a", input, "user_1");

    expect(findMany).toHaveBeenCalledWith({
      where: { id: { in: ["asset_own"] }, eventId: "event_a" },
      select: { id: true },
    });
    expect(create).toHaveBeenCalledTimes(1);
    const createArgs = create.mock.calls[0][0] as {
      data: { links: { create: Array<{ assetId: string | null }> } };
    };
    expect(createArgs.data.links.create[0].assetId).toBe("asset_own");
  });

  it("skips the ownership check entirely when no link points at an uploaded file", async () => {
    const { create, findMany } = mockPrisma([]);
    const input: EventContentInput = {
      sections: [
        { kind: "RICH_TEXT", title: "Lodging", body: "Rooms are held.", placement: "PUBLIC_PAGE", items: [], isPublished: true, links: [] },
      ],
    };

    await replaceEventContent("event_a", input, "user_1");

    expect(findMany).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });
});
