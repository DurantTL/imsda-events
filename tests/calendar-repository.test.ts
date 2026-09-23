import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ eventFindMany: vi.fn(), entryFindMany: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    event: { findMany: mocks.eventFindMany },
    calendarEntry: { findMany: mocks.entryFindMany },
  }),
}));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: vi.fn() }));

import { listPublicCalendarItems } from "@/modules/calendar/repository";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.eventFindMany.mockResolvedValue([{
    id: "event-1",
    slug: "mens-convention",
    name: "Men's Convention",
    startsAt: new Date("2026-12-05T02:00:00Z"),
    endsAt: new Date("2026-12-06T22:00:00Z"),
    timezone: "America/Chicago",
    location: "Lake of the Ozarks",
    calendarCategory: "Men",
    isPublished: true,
    registrationOpensOn: null,
    registrationClosesOn: "2026-11-30",
    waitlistEnabled: false,
  }]);
  mocks.entryFindMany.mockResolvedValue([{
    id: "entry-1",
    title: "Camporee",
    description: "",
    startsOn: "2026-12-12",
    endsOn: "2026-12-13",
    timeLabel: "",
    location: "",
    category: "Youth",
    linkUrl: null,
    status: "POSTPONED",
    isPublished: true,
  }]);
});

describe("public calendar visibility", () => {
  it("asks only for published, calendar-visible events and published entries", async () => {
    await listPublicCalendarItems("2026-11-29", "2027-01-02", new Date("2026-09-23T12:00:00Z"));
    expect(mocks.eventFindMany.mock.calls[0][0].where).toMatchObject({ isPublished: true, showOnCalendar: true });
    expect(mocks.entryFindMany.mock.calls[0][0].where).toMatchObject({ isPublished: true, startsOn: { lte: "2027-01-02" }, endsOn: { gte: "2026-11-29" } });
  });

  it("dates events in their own time zone and links them to their public page", async () => {
    const items = await listPublicCalendarItems("2026-11-29", "2027-01-02", new Date("2026-09-23T12:00:00Z"));
    const event = items.find((candidate) => candidate.kind === "EVENT");
    // 02:00 UTC on December 5 is still December 4 in Chicago.
    expect(event).toMatchObject({ startsOn: "2026-12-04", endsOn: "2026-12-06", href: "/events/mens-convention", category: "Men", registrationOpen: true });
    expect(items.find((candidate) => candidate.kind === "ENTRY")).toMatchObject({ status: "POSTPONED", href: null });
  });
});
