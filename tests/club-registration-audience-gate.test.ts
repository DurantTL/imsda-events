import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn(), getServerEnv: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getServerEnv: dependencies.getServerEnv }));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import { getClubEventWorkspace, listClubEvents } from "@/modules/club-registrations/repository";

/**
 * #481 review: bulk club registration (the club portal) requires both a CLUB
 * audience and church billing, so a GENERAL event billed to an organization
 * never shows up in the portal as a club event.
 */
function mockPrisma() {
  const prisma = {
    event: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  };
  dependencies.getPrisma.mockReturnValue(prisma);
  return prisma;
}

beforeEach(() => vi.clearAllMocks());

describe("club portal event gate (#481)", () => {
  it("lists only CLUB-audience events billed to the church", async () => {
    const prisma = mockPrisma();
    await listClubEvents("org-1", new Date("2026-10-01T00:00:00Z"));
    expect(prisma.event.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE", isPublished: true }),
    }));
  });

  it("opens an event's club workspace only for a CLUB-audience event billed to the church", async () => {
    const prisma = mockPrisma();
    await expect(getClubEventWorkspace("org-1", "event-general")).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    expect(prisma.event.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "event-general", audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE" }),
    }));
  });
});
