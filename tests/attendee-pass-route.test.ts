import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockAccessDeniedError extends Error {
    constructor(
      public readonly code: string,
      public readonly status: 401 | 403,
      message: string,
    ) {
      super(message);
    }
  }
  class MockAttendeePassResolutionError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    AccessDeniedError: MockAccessDeniedError,
    AttendeePassResolutionError: MockAttendeePassResolutionError,
    requirePermission: vi.fn(),
    getCurrentSession: vi.fn(),
    rejectCrossOriginRequest: vi.fn(),
    findActiveMembership: vi.fn(),
    resolveAttendeePassForEvent: vi.fn(),
  };
});

vi.mock("@/modules/access/authorization", () => ({
  AccessDeniedError: mocks.AccessDeniedError,
  requirePermission: mocks.requirePermission,
}));
vi.mock("@/modules/access/current-session", () => ({
  getCurrentSession: mocks.getCurrentSession,
}));
vi.mock("@/modules/access/request-security", () => ({
  rejectCrossOriginRequest: mocks.rejectCrossOriginRequest,
}));
vi.mock("@/modules/events/repository", () => ({
  findActiveMembership: mocks.findActiveMembership,
}));
vi.mock("@/modules/checkin/attendee-pass-repository", () => ({
  AttendeePassResolutionError: mocks.AttendeePassResolutionError,
  resolveAttendeePassForEvent: mocks.resolveAttendeePassForEvent,
}));

import { POST } from "@/app/api/events/[eventId]/attendee-passes/resolve/route";

const context = { params: Promise.resolve({ eventId: "event_123" }) };

function request(body: unknown) {
  return new Request(
    "https://events.imsda.test/api/events/event_123/attendee-passes/resolve",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://events.imsda.test",
      },
      body: JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.getCurrentSession.mockResolvedValue({ user: { id: "staff_1" } });
  mocks.requirePermission.mockResolvedValue({ user: { id: "staff_1" } });
  mocks.resolveAttendeePassForEvent.mockResolvedValue({
    source: "QR_PASS",
    confirmationCode: "REG-ABC12345",
    attendees: [{
      id: "attendee_456",
      firstName: "Retreat",
      lastName: "Guest",
      attendeeType: "ATTENDEE",
      checkedIn: false,
      checkedInAt: null,
    }],
  });
});

describe("attendee pass resolution route", () => {
  it("requires event-scoped check-in permission and returns private no-store data", async () => {
    const response = await POST(
      request({ kind: "pass", value: "imsda-pass.v1.payload.signature" }),
      context,
    );

    expect(response.status).toBe(200);
    expect(mocks.requirePermission).toHaveBeenCalledWith(
      { user: { id: "staff_1" } },
      "event_123",
      "MANAGE_CHECK_IN",
      mocks.findActiveMembership,
    );
    expect(mocks.resolveAttendeePassForEvent).toHaveBeenCalledWith(
      "event_123",
      { kind: "pass", value: "imsda-pass.v1.payload.signature" },
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("supports the explicit manual confirmation-code fallback", async () => {
    await POST(
      request({ kind: "confirmation", value: " REG-ABC12345 " }),
      context,
    );

    expect(mocks.resolveAttendeePassForEvent).toHaveBeenCalledWith(
      "event_123",
      { kind: "confirmation", value: "REG-ABC12345" },
    );
  });

  it("rejects unknown fields before attempting a lookup", async () => {
    const response = await POST(request({
      kind: "confirmation",
      value: "REG-ABC12345",
      attendeeId: "attendee_other",
    }), context);

    expect(response.status).toBe(400);
    expect(mocks.resolveAttendeePassForEvent).not.toHaveBeenCalled();
  });

  it("rejects cross-origin requests before authorization or lookup", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(
      Response.json({ error: "CROSS_ORIGIN_REQUEST_REJECTED" }, { status: 403 }),
    );

    const response = await POST(
      request({ kind: "confirmation", value: "REG-ABC12345" }),
      context,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.requirePermission).not.toHaveBeenCalled();
    expect(mocks.resolveAttendeePassForEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["PASS_UNAVAILABLE", 404],
    ["PASS_EXPIRED", 410],
    ["CONFIRMATION_NOT_FOUND", 404],
    ["REGISTRATION_NOT_ELIGIBLE", 409],
  ])("maps %s to HTTP %i", async (code, status) => {
    mocks.resolveAttendeePassForEvent.mockRejectedValue(
      new mocks.AttendeePassResolutionError(code, "Pass lookup failed."),
    );

    const response = await POST(
      request({ kind: "confirmation", value: "REG-ABC12345" }),
      context,
    );

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      error: code,
      message: "Pass lookup failed.",
    });
  });
});

