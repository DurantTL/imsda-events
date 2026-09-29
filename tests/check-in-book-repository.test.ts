import { beforeEach, describe, expect, it, vi } from "vitest";

/** The location filter (#413) reaches the queries the check-in book reads from. */
const mocks = vi.hoisted(() => ({
  eventFindUnique: vi.fn(),
  clubCount: vi.fn(),
  locationFindMany: vi.fn(),
  getClubEventRecords: vi.fn(),
  listRegistrations: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    event: { findUnique: mocks.eventFindUnique },
    clubEventRegistration: { count: mocks.clubCount },
    eventLocation: { findMany: mocks.locationFindMany },
  }),
}));
vi.mock("@/modules/reporting/club-event-reports-repository", () => ({ getClubEventRecords: mocks.getClubEventRecords }));
vi.mock("@/modules/registrations/repository", () => ({ listRegistrations: mocks.listRegistrations }));

import { getCheckInBookData } from "@/modules/reporting/check-in-book-repository";

const statuses = ["SUBMITTED", "CONFIRMED"] as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.eventFindUnique.mockResolvedValue({
    name: "Synthetic Camporee",
    startsAt: new Date("2026-10-02T00:00:00Z"),
    endsAt: new Date("2026-10-04T00:00:00Z"),
    timezone: "UTC",
  });
  mocks.clubCount.mockResolvedValue(1);
  mocks.locationFindMany.mockResolvedValue([
    { id: "loc-ia", name: "Iowa", isActive: true },
    { id: "loc-mo", name: "Missouri", isActive: true },
  ]);
  mocks.getClubEventRecords.mockResolvedValue({ clubs: [], registrations: [], assignments: new Map(), earlyBirdDeadline: null });
  mocks.listRegistrations.mockResolvedValue([]);
});

describe("getCheckInBookData location filter", () => {
  it("narrows the club query to the chosen location and labels the cover with its name", async () => {
    const data = await getCheckInBookData("event-1", { statuses, location: "loc-mo" });
    expect(mocks.getClubEventRecords).toHaveBeenCalledWith("event-1", { statuses, locationId: "loc-mo" });
    expect(data?.locationId).toBe("loc-mo");
    expect(data?.book.locationLabel).toBe("Missouri");
    expect(data?.locations.map((location) => location.name)).toEqual(["Iowa", "Missouri"]);
  });

  it("prints every location for All locations, or for a stale location id", async () => {
    const all = await getCheckInBookData("event-1", { statuses });
    expect(mocks.getClubEventRecords).toHaveBeenLastCalledWith("event-1", { statuses, locationId: null });
    expect(all?.book.locationLabel).toBe("All locations");
    const stale = await getCheckInBookData("event-1", { statuses, location: "not-a-location" });
    expect(mocks.getClubEventRecords).toHaveBeenLastCalledWith("event-1", { statuses, locationId: null });
    expect(stale?.locationId).toBeNull();
  });

  it("narrows registration-group books too", async () => {
    mocks.clubCount.mockResolvedValue(0);
    await getCheckInBookData("event-1", { statuses, location: "loc-ia" });
    expect(mocks.listRegistrations).toHaveBeenCalledWith("event-1", { statuses, locationId: "loc-ia" });
  });

  it("shows no location on an event without locations", async () => {
    mocks.locationFindMany.mockResolvedValue([]);
    const data = await getCheckInBookData("event-1", { statuses, location: "loc-ia" });
    expect(data?.book.locationLabel).toBeNull();
    expect(mocks.getClubEventRecords).toHaveBeenCalledWith("event-1", { statuses, locationId: null });
  });
});
