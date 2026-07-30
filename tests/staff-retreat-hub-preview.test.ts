import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  listEventsForUser: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: mocks.getPrisma,
}));

vi.mock("@/modules/events/repository", () => ({
  listEventsForUser: mocks.listEventsForUser,
}));

import {
  getStaffRetreatHubPreview,
} from "@/modules/attendee-accounts/retreat-hub-repository";

const eventRow = {
  id: "event-1",
  slug: "womens-retreat",
  name: "Women’s Retreat",
  startsAt: new Date("2026-10-09T21:00:00.000Z"),
  endsAt: new Date("2026-10-11T17:00:00.000Z"),
  timezone: "America/Chicago",
  location: "Camp Heritage",
  supportContact: "registration@example.test",
  announcements: [{
    id: "announcement-1",
    title: "Arrival update",
    body: "Check-in opens at 4 PM.",
    priority: "IMPORTANT" as const,
    publishedAt: new Date("2026-10-08T14:00:00.000Z"),
  }],
  contentSections: [{
    id: "content-1",
    kind: "RICH_TEXT" as const,
    title: "Schedule",
    body: "Friday arrival",
    links: [],
  }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPrisma.mockReturnValue({
    event: {
      findUnique: vi.fn().mockResolvedValue(eventRow),
    },
  });
});

describe("staff retreat-hub preview", () => {
  it("shows shared attendee content without registration-specific data", async () => {
    mocks.listEventsForUser.mockResolvedValue([eventRow]);

    const preview = await getStaffRetreatHubPreview(
      { id: "staff-1", globalRole: null },
      "womens-retreat",
    );

    expect(preview).toMatchObject({
      eventId: "event-1",
      hub: {
        event: {
          slug: "womens-retreat",
          name: "Women’s Retreat",
        },
        announcements: [{
          id: "announcement-1",
          publishedAt: "2026-10-08T14:00:00.000Z",
        }],
        registrations: [],
        assignmentRuns: [],
      },
    });
  });

  it("does not query or reveal an event outside the staff member's access", async () => {
    const findUnique = vi.fn();
    mocks.getPrisma.mockReturnValue({ event: { findUnique } });
    mocks.listEventsForUser.mockResolvedValue([]);

    await expect(getStaffRetreatHubPreview(
      { id: "staff-1", globalRole: null },
      "womens-retreat",
    )).resolves.toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("asks for the full event list only for a system administrator", async () => {
    mocks.listEventsForUser.mockResolvedValue([eventRow]);

    await getStaffRetreatHubPreview(
      { id: "admin-1", globalRole: "SYSTEM_ADMIN" },
      "womens-retreat",
    );

    expect(mocks.listEventsForUser).toHaveBeenCalledWith("admin-1", true);
  });
});
