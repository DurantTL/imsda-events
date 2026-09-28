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
    const { deleteMany, create, auditLogCreate } = mockPrisma([]);
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
        { kind: "RICH_TEXT", title: "Lodging", body: "Rooms are held.", isPublished: true, links: [] },
      ],
    };

    await replaceEventContent("event_a", input, "user_1");

    expect(findMany).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });
});
