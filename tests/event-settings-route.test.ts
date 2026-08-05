import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => {
  class MockEventOperationError extends Error {
    constructor(
      public readonly code: "EVENT_NOT_FOUND" | "EVENT_NOT_READY",
      message: string,
    ) {
      super(message);
      this.name = "EventOperationError";
    }
  }

  return {
    EventOperationError: MockEventOperationError,
    createEvent: vi.fn(),
    findActiveMembership: vi.fn(),
    getCurrentSession: vi.fn(),
    getEventSettings: vi.fn(),
    listEventsForUser: vi.fn(),
    updateEventSettings: vi.fn(),
  };
});

vi.mock("@/modules/access/current-session", () => ({
  getCurrentSession: dependencies.getCurrentSession,
}));

vi.mock("@/modules/events/repository", () => ({
  EventOperationError: dependencies.EventOperationError,
  createEvent: dependencies.createEvent,
  findActiveMembership: dependencies.findActiveMembership,
  getEventSettings: dependencies.getEventSettings,
  listEventsForUser: dependencies.listEventsForUser,
  updateEventSettings: dependencies.updateEventSettings,
}));

import { POST } from "@/app/api/events/route";
import { PATCH } from "@/app/api/events/[eventId]/route";

const eventPayload = {
  name: "Women’s Retreat 2028",
  slug: "womens-retreat-2028",
  startsOn: "2028-10-13",
  endsOn: "2028-10-15",
  timezone: "America/Chicago",
  location: "Camp Heritage",
  capacity: 350,
  publicInfoUrl: "https://imsda.org/event/womens-retreat/",
  supportContact: "registration@imsda.org",
  isPublished: true,
  registrationOpensOn: "2028-05-01",
  registrationClosesOn: "2028-10-01",
  collectsShirtSizes: false,
  attendeeEditPolicy: "VERIFY_EVERY_EDIT",
  waitlistEnabled: true,
  autoPromoteWaitlist: true,
};

/**
 * What the route hands the repository for a payload that omits lodging: the
 * keys stay absent rather than becoming null. The repository turns an absence
 * into "leave the stored value alone" on update and into "no room block" on
 * create, so an older client saving an unrelated setting cannot erase lodging
 * it never knew about.
 */
const normalizedEventPayload = {
  ...eventPayload,
  hotelName: undefined,
  hotelBookingUrl: undefined,
  hotelPhone: undefined,
  hotelGroupName: undefined,
  hotelRate: undefined,
  hotelInstructions: undefined,
  seminarPreferenceClosesOn: null,
  seminarPreferenceSelfServiceLocked: false,
  billingMode: "ATTENDEE_PAY",
};

function eventRequest(
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
  origin = "https://events.imsda.test",
) {
  return new Request(`https://events.imsda.test${path}`, {
    method,
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getCurrentSession.mockResolvedValue({
    user: {
      id: "usr_system",
      email: "system@example.test",
      displayName: "System Admin",
      globalRole: "SYSTEM_ADMIN",
    },
  });
});

describe("event settings routes", () => {
  it("creates only a private draft, even if a client requests publishing", async () => {
    dependencies.createEvent.mockResolvedValue({ id: "evt_new", isPublished: false });

    const response = await POST(eventRequest("/api/events", "POST", eventPayload));

    expect(response.status).toBe(201);
    expect(dependencies.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ isPublished: false, slug: "womens-retreat-2028" }),
      "usr_system",
    );
    expect(await response.json()).toMatchObject({
      event: { id: "evt_new", isPublished: false },
    });
  });

  it("requires a system administrator to create an event", async () => {
    dependencies.getCurrentSession.mockResolvedValue({
      user: {
        id: "usr_staff",
        email: "staff@example.test",
        displayName: "Staff",
        globalRole: null,
      },
    });

    const response = await POST(eventRequest("/api/events", "POST", eventPayload));

    expect(response.status).toBe(403);
    expect(dependencies.createEvent).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ error: "PERMISSION_DENIED" });
  });

  it("rejects invalid and cross-origin create requests before writing", async () => {
    const invalid = await POST(eventRequest("/api/events", "POST", {
      ...eventPayload,
      endsOn: "2028-10-12",
    }));
    expect(invalid.status).toBe(400);

    const crossOrigin = await POST(eventRequest(
      "/api/events",
      "POST",
      eventPayload,
      "https://untrusted.example",
    ));
    expect(crossOrigin.status).toBe(403);
    expect(dependencies.createEvent).not.toHaveBeenCalled();
  });

  it("authorizes and validates an event settings update", async () => {
    dependencies.updateEventSettings.mockResolvedValue({
      id: "evt_wr28",
      ...eventPayload,
    });

    const response = await PATCH(
      eventRequest("/api/events/evt_wr28", "PATCH", eventPayload),
      { params: Promise.resolve({ eventId: "evt_wr28" }) },
    );

    expect(response.status).toBe(200);
    expect(dependencies.updateEventSettings).toHaveBeenCalledWith(
      "evt_wr28",
      normalizedEventPayload,
      "usr_system",
    );
    const [, forwarded] = dependencies.updateEventSettings.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    // Absent, not null. A null would be written as a deletion.
    expect("hotelName" in forwarded ? forwarded.hotelName : undefined).toBeUndefined();
  });

  it("keeps an explicit blank as a clear rather than as an omission", async () => {
    dependencies.updateEventSettings.mockResolvedValue({
      id: "evt_wr28",
      ...eventPayload,
    });

    await PATCH(
      eventRequest("/api/events/evt_wr28", "PATCH", {
        ...eventPayload,
        hotelName: "   ",
      }),
      { params: Promise.resolve({ eventId: "evt_wr28" }) },
    );

    const [, forwarded] = dependencies.updateEventSettings.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(forwarded.hotelName).toBeNull();
  });
});
