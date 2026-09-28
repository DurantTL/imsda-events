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
    publishEvent: vi.fn(),
    unpublishEvent: vi.fn(),
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
  publishEvent: dependencies.publishEvent,
  unpublishEvent: dependencies.unpublishEvent,
}));

import { POST } from "@/app/api/events/route";
import { PATCH } from "@/app/api/events/[eventId]/route";
import { POST as PUBLISH } from "@/app/api/events/[eventId]/publish/route";
import { POST as UNPUBLISH } from "@/app/api/events/[eventId]/unpublish/route";

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
// `isPublished` is stripped by the schema (#471): publishing has its own
// routes, so a client-sent value never reaches a settings save.
const { isPublished: _clientSentIsPublished, ...eventPayloadWithoutPublish } = eventPayload;
void _clientSentIsPublished;
const normalizedEventPayload = {
  ...eventPayloadWithoutPublish,
  checksAdultBackgrounds: false,
  hotelName: undefined,
  hotelBookingUrl: undefined,
  hotelPhone: undefined,
  hotelGroupName: undefined,
  hotelRate: undefined,
  hotelInstructions: undefined,
  seminarPreferenceClosesOn: null,
  seminarPreferenceSelfServiceLocked: false,
  billingMode: "ATTENDEE_PAY",
  // Absent, not defaulted (#481 review): the repository turns an absence into
  // GENERAL on create and "keep the stored audience" on update.
  audience: undefined,
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
      expect.objectContaining({ slug: "womens-retreat-2028" }),
      "usr_system",
    );
    // The client's `isPublished: true` never reaches the repository, which
    // always creates a draft.
    expect(dependencies.createEvent.mock.calls[0]![0]).not.toHaveProperty("isPublished");
    expect(await response.json()).toMatchObject({
      event: { id: "evt_new", isPublished: false },
    });
  });

  it("leaves an omitted audience absent and forwards an explicit CLUB audience (#481)", async () => {
    dependencies.createEvent.mockResolvedValue({ id: "evt_new", audience: "GENERAL" });

    await POST(eventRequest("/api/events", "POST", eventPayload));
    const [forwarded] = dependencies.createEvent.mock.calls[0] as [Record<string, unknown>];
    expect(forwarded.audience).toBeUndefined();

    dependencies.createEvent.mockClear();
    await POST(eventRequest("/api/events", "POST", { ...eventPayload, audience: "CLUB" }));
    expect(dependencies.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ audience: "CLUB" }),
      "usr_system",
    );
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

  it("accepts an update with no IMSDA.org information page (#467)", async () => {
    dependencies.updateEventSettings.mockResolvedValue({
      id: "evt_wr28",
      ...eventPayload,
      publicInfoUrl: null,
    });

    for (const publicInfoUrl of [null, ""]) {
      dependencies.updateEventSettings.mockClear();
      const response = await PATCH(
        eventRequest("/api/events/evt_wr28", "PATCH", { ...eventPayload, publicInfoUrl }),
        { params: Promise.resolve({ eventId: "evt_wr28" }) },
      );

      expect(response.status).toBe(200);
      const [, forwarded] = dependencies.updateEventSettings.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(forwarded.publicInfoUrl).toBeNull();
    }
  });

  it("never lets an event settings save change isPublished, since it is not sent to that repository call", async () => {
    // The route parses and forwards the schema-shaped payload as always —
    // `updateEventSettings` itself is what now ignores `isPublished`
    // (tested at the repository level in event-publish-readiness-repository
    // .test.ts). This asserts the route never grows a second, competing way
    // to toggle it (#471).
    dependencies.updateEventSettings.mockResolvedValue({ id: "evt_wr28", ...eventPayload });

    await PATCH(
      eventRequest("/api/events/evt_wr28", "PATCH", { ...eventPayload, isPublished: false }),
      { params: Promise.resolve({ eventId: "evt_wr28" }) },
    );

    expect(dependencies.publishEvent).not.toHaveBeenCalled();
    expect(dependencies.unpublishEvent).not.toHaveBeenCalled();
  });

  it("strips a client-sent isPublished, so the settings audit's `after` can never record it", async () => {
    dependencies.updateEventSettings.mockResolvedValue({ id: "evt_wr28", ...eventPayload });

    for (const isPublished of [true, false]) {
      dependencies.updateEventSettings.mockClear();
      const response = await PATCH(
        eventRequest("/api/events/evt_wr28", "PATCH", { ...eventPayload, isPublished }),
        { params: Promise.resolve({ eventId: "evt_wr28" }) },
      );
      expect(response.status).toBe(200);
      const [, forwarded] = dependencies.updateEventSettings.mock.calls[0] as [string, Record<string, unknown>];
      expect(forwarded).not.toHaveProperty("isPublished");
    }
  });
});

describe("event publish/unpublish routes (#471)", () => {
  function actionRequest(path: string, origin = "https://events.imsda.test") {
    return new Request(`https://events.imsda.test${path}`, {
      method: "POST",
      headers: { origin },
    });
  }

  it("publishes an event as its own action", async () => {
    dependencies.publishEvent.mockResolvedValue({ id: "evt_wr28", isPublished: true });

    const response = await PUBLISH(
      actionRequest("/api/events/evt_wr28/publish"),
      { params: Promise.resolve({ eventId: "evt_wr28" }) },
    );

    expect(response.status).toBe(200);
    expect(dependencies.publishEvent).toHaveBeenCalledWith("evt_wr28", "usr_system");
    expect(await response.json()).toMatchObject({ event: { isPublished: true } });
  });

  it("reports a blocked publish without a generic 500", async () => {
    dependencies.publishEvent.mockRejectedValue(
      new dependencies.EventOperationError("EVENT_NOT_READY", "Finish the publish checklist first: support contact."),
    );

    const response = await PUBLISH(
      actionRequest("/api/events/evt_wr28/publish"),
      { params: Promise.resolve({ eventId: "evt_wr28" }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "EVENT_NOT_READY" });
  });

  it("unpublishes an event as its own action", async () => {
    dependencies.unpublishEvent.mockResolvedValue({ id: "evt_wr28", isPublished: false });

    const response = await UNPUBLISH(
      actionRequest("/api/events/evt_wr28/unpublish"),
      { params: Promise.resolve({ eventId: "evt_wr28" }) },
    );

    expect(response.status).toBe(200);
    expect(dependencies.unpublishEvent).toHaveBeenCalledWith("evt_wr28", "usr_system");
    expect(await response.json()).toMatchObject({ event: { isPublished: false } });
  });

  it("rejects a cross-origin unpublish request before writing", async () => {
    const response = await UNPUBLISH(
      actionRequest("/api/events/evt_wr28/unpublish", "https://untrusted.example"),
      { params: Promise.resolve({ eventId: "evt_wr28" }) },
    );

    expect(response.status).toBe(403);
    expect(dependencies.unpublishEvent).not.toHaveBeenCalled();
  });

  it("requires event configuration permission to unpublish", async () => {
    dependencies.getCurrentSession.mockResolvedValue({
      user: { id: "usr_staff", email: "staff@example.test", displayName: "Staff", globalRole: null },
    });
    dependencies.findActiveMembership.mockResolvedValue(null);

    const response = await UNPUBLISH(
      actionRequest("/api/events/evt_wr28/unpublish"),
      { params: Promise.resolve({ eventId: "evt_wr28" }) },
    );

    expect(response.status).toBe(403);
    expect(dependencies.unpublishEvent).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin or unpermitted publish request before writing", async () => {
    const crossOrigin = await PUBLISH(
      actionRequest("/api/events/evt_wr28/publish", "https://untrusted.example"),
      { params: Promise.resolve({ eventId: "evt_wr28" }) },
    );
    expect(crossOrigin.status).toBe(403);

    dependencies.getCurrentSession.mockResolvedValue({
      user: { id: "usr_staff", email: "staff@example.test", displayName: "Staff", globalRole: null },
    });
    dependencies.findActiveMembership.mockResolvedValue(null);
    const denied = await PUBLISH(
      actionRequest("/api/events/evt_wr28/publish"),
      { params: Promise.resolve({ eventId: "evt_wr28" }) },
    );
    expect(denied.status).toBe(403);
    expect(dependencies.publishEvent).not.toHaveBeenCalled();
  });

  it("maps a missing event to 404 on publish and unpublish", async () => {
    const missing = new dependencies.EventOperationError("EVENT_NOT_FOUND", "That event no longer exists.");
    dependencies.publishEvent.mockRejectedValue(missing);
    dependencies.unpublishEvent.mockRejectedValue(missing);

    const published = await PUBLISH(
      actionRequest("/api/events/evt_gone/publish"),
      { params: Promise.resolve({ eventId: "evt_gone" }) },
    );
    const unpublished = await UNPUBLISH(
      actionRequest("/api/events/evt_gone/unpublish"),
      { params: Promise.resolve({ eventId: "evt_gone" }) },
    );
    expect(published.status).toBe(404);
    expect(unpublished.status).toBe(404);
  });
});
