import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  listEventsForUser: vi.fn(),
  findActiveMembership: vi.fn(),
  listRegistrations: vi.fn(),
  backgroundFlaggedAttendeeIds: vi.fn(),
  listClubCheckInInfo: vi.fn(),
  listActiveEventPermissionsForUser: vi.fn(),
  readLastUsedEventId: vi.fn(),
  redirect: vi.fn((destination: string) => {
    throw new Error(`redirected:${destination}`);
  }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: dependencies.redirect,
}));
vi.mock("@/modules/access/current-session", () => ({
  getCurrentSession: dependencies.getCurrentSession,
}));
vi.mock("@/modules/events/repository", () => ({
  listEventsForUser: dependencies.listEventsForUser,
  findActiveMembership: dependencies.findActiveMembership,
}));
vi.mock("@/modules/access/membership-repository", () => ({
  listActiveEventPermissionsForUser: dependencies.listActiveEventPermissionsForUser,
}));
vi.mock("@/modules/events/last-used-event", () => ({
  readLastUsedEventId: dependencies.readLastUsedEventId,
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

function event(id: string, endsAt = new Date("2099-01-01T00:00:00Z")) {
  return { id, name: `Event ${id}`, endsAt };
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getCurrentSession.mockResolvedValue({
    user: { id: "user_one", email: "staff@example.test", displayName: "Staff" },
  });
  dependencies.listRegistrations.mockResolvedValue([]);
  dependencies.backgroundFlaggedAttendeeIds.mockResolvedValue([]);
  dependencies.listClubCheckInInfo.mockResolvedValue([]);
  dependencies.listActiveEventPermissionsForUser.mockResolvedValue(new Map());
  dependencies.readLastUsedEventId.mockResolvedValue(null);
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

    expect(markup).toContain("Staff access required");
    expect(dependencies.listClubCheckInInfo).not.toHaveBeenCalled();
    expect(dependencies.listRegistrations).not.toHaveBeenCalled();
  });
});

describe("check-in entry routing (#470)", () => {
  it("sends a signed-out visitor to staff sign-in with a return path to check-in", async () => {
    dependencies.getCurrentSession.mockResolvedValue({ user: null });

    await expect(CheckInPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("redirected:/login?next=/check-in");
    expect(dependencies.listEventsForUser).not.toHaveBeenCalled();
  });

  it("keeps a requested event in the sign-in return path", async () => {
    dependencies.getCurrentSession.mockResolvedValue({ user: null });

    await expect(CheckInPage({ searchParams: Promise.resolve({ event: "event_b" }) }))
      .rejects.toThrow(`redirected:/login?next=${encodeURIComponent("/check-in?event=event_b")}`);
  });

  it("opens the event where the account has MANAGE_CHECK_IN, not simply the first event", async () => {
    dependencies.listEventsForUser.mockResolvedValue([event("event_a"), event("event_b"), event("event_c")]);
    dependencies.listActiveEventPermissionsForUser.mockResolvedValue(new Map([
      ["event_a", ["VIEW_EVENT"]],
      ["event_b", ["VIEW_EVENT", "MANAGE_CHECK_IN"]],
      ["event_c", ["VIEW_EVENT"]],
    ]));

    await expect(CheckInPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("redirected:/check-in?event=event_b");
    expect(dependencies.listRegistrations).not.toHaveBeenCalled();
  });

  it("prefers the remembered event when it has check-in access", async () => {
    dependencies.listEventsForUser.mockResolvedValue([event("event_a"), event("event_b")]);
    dependencies.listActiveEventPermissionsForUser.mockResolvedValue(new Map([
      ["event_a", ["MANAGE_CHECK_IN"]],
      ["event_b", ["MANAGE_CHECK_IN"]],
    ]));
    dependencies.readLastUsedEventId.mockResolvedValue("event_b");

    await expect(CheckInPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("redirected:/check-in?event=event_b");
  });

  it("ignores a remembered event without check-in access", async () => {
    dependencies.listEventsForUser.mockResolvedValue([event("event_a"), event("event_b")]);
    dependencies.listActiveEventPermissionsForUser.mockResolvedValue(new Map([
      ["event_a", ["MANAGE_CHECK_IN"]],
      ["event_b", ["VIEW_EVENT"]],
    ]));
    dependencies.readLastUsedEventId.mockResolvedValue("event_b");

    await expect(CheckInPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("redirected:/check-in?event=event_a");
  });

  it("shows the branded staff-access page to staff with no check-in access anywhere", async () => {
    dependencies.listEventsForUser.mockResolvedValue([event("event_a")]);
    dependencies.listActiveEventPermissionsForUser.mockResolvedValue(new Map([["event_a", ["VIEW_EVENT"]]]));
    dependencies.findActiveMembership.mockResolvedValue({
      eventId: "event_a", userId: "user_one", role: "READ_ONLY_STAFF", status: "ACTIVE", permissions: [],
    });

    const markup = renderToStaticMarkup(await CheckInPage({ searchParams: Promise.resolve({}) }));

    expect(dependencies.redirect).not.toHaveBeenCalled();
    expect(markup).toContain("Staff access required");
    expect(markup).toContain("event administrators and check-in staff");
    expect(markup).toContain("ask the event administrator to add check-in access");
    expect(dependencies.listRegistrations).not.toHaveBeenCalled();
  });
});
