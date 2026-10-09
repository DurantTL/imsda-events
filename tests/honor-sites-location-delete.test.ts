import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPrisma: vi.fn(), lockEventLocation: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/event-locations/admission", async () => {
  const actual = await vi.importActual<typeof import("@/modules/event-locations/admission")>("@/modules/event-locations/admission");
  return { ...actual, lockEventLocation: mocks.lockEventLocation };
});

import { deleteEventLocation } from "@/modules/event-locations/repository";

// Synthetic data only.
function database(counts: { registrations?: number; sessions?: number; classes?: number; rooms?: number }) {
  const tx = {
    registration: { count: vi.fn().mockResolvedValue(counts.registrations ?? 0), findMany: vi.fn().mockResolvedValue([]) },
    honorSession: { count: vi.fn().mockResolvedValue(counts.sessions ?? 0) },
    honorOffering: { count: vi.fn().mockResolvedValue(counts.classes ?? 0) },
    honorRoom: { count: vi.fn().mockResolvedValue(counts.rooms ?? 0) },
    eventLocation: { delete: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { create: vi.fn() },
  };
  mocks.getPrisma.mockReturnValue({ ...tx, $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)) });
  return tx;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lockEventLocation.mockResolvedValue({ id: "loc-1", eventId: "event-1", name: "Des Moines" });
});

describe("deleting a location with honors sessions (#589)", () => {
  it("refuses with a plain message when honors sessions are at the site, and deletes nothing", async () => {
    const tx = database({ sessions: 2 });
    await expect(deleteEventLocation("event-1", "loc-1", "usr_admin")).rejects.toMatchObject({
      code: "LOCATION_IN_USE",
      message: "2 honors sessions are at this site. Move or remove them first.",
    });
    expect(tx.eventLocation.delete).not.toHaveBeenCalled();
  });

  it("says so for one session, and counts all-sessions classes at the site too", async () => {
    database({ sessions: 1 });
    await expect(deleteEventLocation("event-1", "loc-1", "usr_admin")).rejects.toMatchObject({
      message: "1 honors session is at this site. Move or remove it first.",
    });
    database({ classes: 1 });
    await expect(deleteEventLocation("event-1", "loc-1", "usr_admin")).rejects.toMatchObject({
      message: "1 all-sessions class is at this site. Move or remove it first.",
    });
    database({ rooms: 2 });
    await expect(deleteEventLocation("event-1", "loc-1", "usr_admin")).rejects.toMatchObject({
      message: "2 honors rooms are at this site. Move or remove them first.",
    });
    database({ sessions: 2, classes: 1 });
    await expect(deleteEventLocation("event-1", "loc-1", "usr_admin")).rejects.toMatchObject({
      message: "2 honors sessions and 1 all-sessions class are at this site. Move or remove them first.",
    });
    database({ sessions: 1, classes: 2 });
    await expect(deleteEventLocation("event-1", "loc-1", "usr_admin")).rejects.toMatchObject({
      message: "1 honors session and 2 all-sessions classes are at this site. Move or remove them first.",
    });
  });

  it("still refuses for registrations first, and deletes a site nothing uses", async () => {
    database({ registrations: 1, sessions: 1 });
    await expect(deleteEventLocation("event-1", "loc-1", "usr_admin")).rejects.toMatchObject({ message: expect.stringContaining("registration") });
    const tx = database({});
    await deleteEventLocation("event-1", "loc-1", "usr_admin");
    expect(tx.eventLocation.delete).toHaveBeenCalledWith({ where: { id: "loc-1" } });
  });
});
