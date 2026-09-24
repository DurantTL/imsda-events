import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  listEventsForUser: vi.fn(),
  findActiveMembership: vi.fn(),
  listRegistrations: vi.fn(),
  backgroundFlaggedAttendeeIds: vi.fn(),
  listClubCheckInInfo: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("redirected");
  }),
}));
vi.mock("@/modules/access/current-session", () => ({
  getCurrentSession: dependencies.getCurrentSession,
}));
vi.mock("@/modules/events/repository", () => ({
  listEventsForUser: dependencies.listEventsForUser,
  findActiveMembership: dependencies.findActiveMembership,
}));
vi.mock("@/modules/registrations/repository", () => ({
  listRegistrations: dependencies.listRegistrations,
}));
vi.mock("@/modules/background-checks/repository", () => ({
  backgroundFlaggedAttendeeIds: dependencies.backgroundFlaggedAttendeeIds,
}));
vi.mock("@/modules/club-registrations/repository", () => ({
  listClubCheckInInfo: dependencies.listClubCheckInInfo,
}));

import CheckInPage from "@/app/(workspace)/check-in/page";

function event(id: string) {
  return { id, name: `Event ${id}` };
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getCurrentSession.mockResolvedValue({
    user: { id: "user_one", email: "staff@example.test", displayName: "Staff" },
  });
  dependencies.listRegistrations.mockResolvedValue([]);
  dependencies.backgroundFlaggedAttendeeIds.mockResolvedValue([]);
  dependencies.listClubCheckInInfo.mockResolvedValue([]);
});

describe("check-in page access (#412 reviewer leftover)", () => {
  it("never loads event B's clubs for staff with MANAGE_CHECK_IN only on event A", async () => {
    dependencies.listEventsForUser.mockResolvedValue([event("event_a")]);
    dependencies.findActiveMembership.mockImplementation(async (userId: string, eventId: string) => (
      eventId === "event_a"
        ? { eventId, userId, role: "CHECK_IN_STAFF", status: "ACTIVE", permissions: ["MANAGE_CHECK_IN"] }
        : null
    ));

    await CheckInPage({ searchParams: Promise.resolve({ event: "event_b" }) });

    expect(dependencies.listClubCheckInInfo).not.toHaveBeenCalledWith("event_b");
    expect(dependencies.listClubCheckInInfo).toHaveBeenCalledWith("event_a");
  });

  it("never loads clubs at all for a member without MANAGE_CHECK_IN", async () => {
    dependencies.listEventsForUser.mockResolvedValue([event("event_a"), event("event_b")]);
    dependencies.findActiveMembership.mockImplementation(async (userId: string, eventId: string) => ({
      eventId,
      userId,
      role: "READ_ONLY_STAFF",
      status: "ACTIVE",
      permissions: [],
    }));

    const markup = renderToStaticMarkup(
      await CheckInPage({ searchParams: Promise.resolve({ event: "event_b" }) }),
    );

    expect(markup).toContain("Check-in is restricted");
    expect(dependencies.listClubCheckInInfo).not.toHaveBeenCalled();
    expect(dependencies.listRegistrations).not.toHaveBeenCalled();
  });
});
