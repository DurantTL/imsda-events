import { renderToStaticMarkup } from "react-dom/server";
import { redirect } from "next/navigation";
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
vi.mock("@/modules/event-locations/filter", () => ({
  resolveLocationFilter: vi.fn(async () => ({ locations: [], locationId: null })),
}));
vi.mock("@/modules/club-registrations/repository", () => ({
  listClubCheckInInfo: dependencies.listClubCheckInInfo,
}));

import CheckInPage from "@/app/(workspace)/check-in/page";
import { resolveLocationFilter } from "@/modules/event-locations/filter";

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

describe("check-in page access (#412 reviewer leftover, #465)", () => {
  it("never loads event B's clubs — or falls back to event A's — for staff with MANAGE_CHECK_IN only on event A; it sends them to the picker instead", async () => {
    dependencies.listEventsForUser.mockResolvedValue([event("event_a")]);
    dependencies.findActiveMembership.mockImplementation(async (userId: string, eventId: string) => (
      eventId === "event_a"
        ? { eventId, userId, role: "CHECK_IN_STAFF", status: "ACTIVE", permissions: ["MANAGE_CHECK_IN"] }
        : null
    ));

    await expect(CheckInPage({ searchParams: Promise.resolve({ event: "event_b" }) })).rejects.toThrow("redirected");
    expect(redirect).toHaveBeenCalledWith("/select-event?unavailable=1");

    expect(dependencies.listClubCheckInInfo).not.toHaveBeenCalled();
    expect(dependencies.listRegistrations).not.toHaveBeenCalled();
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

describe("check-in page payload (#757)", () => {
  const answerKeys = ["responses", "originalResponses", "attendeeResponses", "publicSubmission", "definition", "profileSnapshot", "payments", "messages", "phone"];
  function fullRegistration() {
    return {
      id: "reg_1",
      confirmationCode: "SYN-0001",
      status: "CONFIRMED",
      balanceCents: 2500,
      isDeferredOrganizationBilling: false,
      accountHolder: { id: "p1", firstName: "Pat", lastName: "Example", email: "pat@example.test", phone: "555-0100" },
      attendees: [
        { id: "att_1", firstName: "Casey", lastName: "Sample", email: "casey@example.test", phone: "555-0101", attendeeType: "YOUTH", position: 0, source: "STAFF", responses: { allergies: "SYNTHETIC-SECRET-ANSWER" }, checkedIn: true, checkInId: "ci_1", checkedInAt: "2026-07-01T10:00:00.000Z" },
        { id: "att_2", firstName: "Robin", lastName: "Sample", email: "", phone: "", attendeeType: "ADULT", position: 1, source: "STAFF", responses: {}, checkedIn: false, checkInId: null, checkedInAt: null },
      ],
      publicSubmission: { responses: { medical: "SYNTHETIC-SECRET-ANSWER" }, attendeeResponses: [{ medical: "SYNTHETIC-SECRET-ANSWER" }] },
      payments: [{ id: "pay_1", externalReference: "SYNTHETIC-REF" }],
    };
  }

  async function renderedProps(permissions: string[]) {
    dependencies.listEventsForUser.mockResolvedValue([{ ...event("event_a"), billingMode: "PAY_AT_REGISTRATION" }]);
    dependencies.findActiveMembership.mockResolvedValue({ eventId: "event_a", userId: "user_one", role: "CHECK_IN_STAFF", status: "ACTIVE", permissions });
    dependencies.listRegistrations.mockResolvedValue([fullRegistration()]);
    const element = await CheckInPage({ searchParams: Promise.resolve({ event: "event_a" }) });
    const children = (element as { props: { children: Array<{ props: Record<string, unknown> }> } }).props.children;
    return children[1].props;
  }

  it.each([
    ["MANAGE_CHECK_IN only", ["MANAGE_CHECK_IN"]],
    ["MANAGE_CHECK_IN with VIEW_SENSITIVE_DATA", ["MANAGE_CHECK_IN", "VIEW_SENSITIVE_DATA"]],
  ])("sends the client only projected arrivals, with no form answers (%s)", async (_label, permissions) => {
    const props = await renderedProps(permissions);
    expect(props.initialRegistrations).toBeUndefined();
    const serialized = JSON.stringify(props);
    expect(serialized).not.toContain("SYNTHETIC-SECRET-ANSWER");
    expect(serialized).not.toContain("SYNTHETIC-REF");
    for (const key of answerKeys) expect(serialized).not.toContain(`"${key}"`);
    expect(props.initialArrivals).toEqual([
      { id: "att_1", firstName: "Casey", lastName: "Sample", attendeeType: "YOUTH", checkedIn: true, checkedInAt: "2026-07-01T10:00:00.000Z", confirmationCode: "SYN-0001", balanceCents: 2500, partySize: 2 },
      { id: "att_2", firstName: "Robin", lastName: "Sample", attendeeType: "ADULT", checkedIn: false, checkedInAt: null, confirmationCode: "SYN-0001", balanceCents: 2500, partySize: 2 },
    ]);
  });

  it("zeroes balances for church-billed events", async () => {
    dependencies.listEventsForUser.mockResolvedValue([{ ...event("event_a"), billingMode: "DEFERRED_ORGANIZATION_INVOICE" }]);
    dependencies.findActiveMembership.mockResolvedValue({ eventId: "event_a", userId: "user_one", role: "CHECK_IN_STAFF", status: "ACTIVE", permissions: ["MANAGE_CHECK_IN"] });
    dependencies.listRegistrations.mockResolvedValue([fullRegistration()]);
    const element = await CheckInPage({ searchParams: Promise.resolve({ event: "event_a" }) });
    const props = (element as { props: { children: Array<{ props: { initialArrivals: Array<{ balanceCents: number }> } }> } }).props.children[1].props;
    expect(props.initialArrivals.map((arrival) => arrival.balanceCents)).toEqual([0, 0]);
  });
});

describe("check-in desk location (#413)", () => {
  it("uses the compact select, passes the chosen location to the roster, and names an inactive one as such", async () => {
    const locations = [{ id: "loc_a", name: "Sunnydale Academy", isActive: true }, { id: "loc_b", name: "Old Campus", isActive: false }];
    dependencies.listEventsForUser.mockResolvedValue([event("event_a")]);
    dependencies.findActiveMembership.mockResolvedValue({ eventId: "event_a", userId: "user_one", role: "CHECK_IN_STAFF", status: "ACTIVE", permissions: ["MANAGE_CHECK_IN"] });
    vi.mocked(resolveLocationFilter).mockResolvedValueOnce({ locations, locationId: "loc_b", selected: locations[1] });
    const element = await CheckInPage({ searchParams: Promise.resolve({ event: "event_a", location: "loc_b" }) });
    const [filter, workspace] = (element as { props: { children: Array<{ type: { name: string }; props: Record<string, unknown> }> } }).props.children;
    expect(filter.type.name).toBe("DeskLocationSelect");
    expect(filter.props.selectedId).toBe("loc_b");
    expect(workspace.props.locationName).toBe("Old Campus (inactive)");
  });
});
