import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveEventContext: vi.fn(),
  eventFindUnique: vi.fn(),
  registrationFindFirst: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    event: { findUnique: mocks.eventFindUnique },
    clubEventRegistration: { findFirst: mocks.registrationFindFirst },
  }),
}));
vi.mock("@/modules/events/selection", () => ({ resolveEventContext: mocks.resolveEventContext }));

import { isClubRegisteredForEvent, resolveClubOversight } from "@/modules/club-rosters/event-oversight";

function context(role: string | null, globalRole = "STAFF") {
  return { event: { id: "event-1" }, user: { id: "user-1", globalRole }, membership: role ? { role } : null, permissions: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.eventFindUnique.mockResolvedValue({ id: "event-1", name: "Camporee", billingMode: "DEFERRED_ORGANIZATION_INVOICE" });
});

describe("Pathfinder event managers (#387)", () => {
  it("lets event administrators of a club event oversee its clubs", async () => {
    mocks.resolveEventContext.mockResolvedValue(context("EVENT_ADMIN"));
    await expect(resolveClubOversight("event-1")).resolves.toMatchObject({ allowed: true });
  });

  it("keeps other roles, and events clubs don't register for, out", async () => {
    mocks.resolveEventContext.mockResolvedValue(context("REGISTRATION_MANAGER"));
    await expect(resolveClubOversight("event-1")).resolves.toMatchObject({ allowed: false });

    mocks.resolveEventContext.mockResolvedValue(context("EVENT_ADMIN"));
    mocks.eventFindUnique.mockResolvedValue({ id: "event-1", name: "Retreat", billingMode: "INDIVIDUAL" });
    await expect(resolveClubOversight("event-1")).resolves.toMatchObject({ allowed: false, clubEvent: false });
  });

  it("lets system administrators oversee any club event", async () => {
    mocks.resolveEventContext.mockResolvedValue(context(null, "SYSTEM_ADMIN"));
    await expect(resolveClubOversight("event-1")).resolves.toMatchObject({ allowed: true });
  });

  it("only opens clubs registered for this event", async () => {
    mocks.registrationFindFirst.mockResolvedValueOnce({ id: "row-1" }).mockResolvedValueOnce(null);
    await expect(isClubRegisteredForEvent("event-1", "club-1")).resolves.toBe(true);
    await expect(isClubRegisteredForEvent("event-1", "club-2")).resolves.toBe(false);
    expect(mocks.registrationFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ eventId: "event-1", organizationId: "club-1" }),
    }));
  });
});
