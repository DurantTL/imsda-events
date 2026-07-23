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
  class MockCheckInOperationError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    AccessDeniedError: MockAccessDeniedError,
    CheckInOperationError: MockCheckInOperationError,
    requirePermission: vi.fn(),
    getCurrentSession: vi.fn(),
    rejectCrossOriginRequest: vi.fn(),
    findActiveMembership: vi.fn(),
    checkInAttendee: vi.fn(),
    undoCheckIn: vi.fn(),
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
vi.mock("@/modules/checkin/repository", () => ({
  CheckInOperationError: mocks.CheckInOperationError,
  checkInAttendee: mocks.checkInAttendee,
  undoCheckIn: mocks.undoCheckIn,
}));

import {
  DELETE,
  POST,
} from "@/app/api/events/[eventId]/attendees/[attendeeId]/check-in/route";

const idempotencyKey = "d67776d0-f79d-4e8f-bec2-ee61abb7337c";
const context = {
  params: Promise.resolve({
    eventId: "event_123",
    attendeeId: "attendee_123",
  }),
};

function request(body: unknown) {
  return new Request(
    "https://events.imsda.test/api/events/event_123/attendees/attendee_123/check-in",
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
  mocks.checkInAttendee.mockResolvedValue({
    checkedIn: true,
    disposition: "CREATED",
    checkIn: {
      id: "checkin_1",
      checkedInAt: new Date("2026-07-23T14:00:00.000Z"),
      undoneAt: null,
    },
  });
});

describe("check-in route", () => {
  it("requires an event-scoped permission and forwards the strict retry key", async () => {
    const response = await POST(request({ idempotencyKey }), context);

    expect(response.status).toBe(200);
    expect(mocks.requirePermission).toHaveBeenCalledWith(
      { user: { id: "staff_1" } },
      "event_123",
      "MANAGE_CHECK_IN",
      mocks.findActiveMembership,
    );
    expect(mocks.checkInAttendee).toHaveBeenCalledWith(
      "event_123",
      "attendee_123",
      "staff_1",
      idempotencyKey,
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({
      checkedIn: true,
      disposition: "CREATED",
    });
  });

  it.each([
    [{ idempotencyKey: "not-a-uuid" }],
    [{ idempotencyKey, attendeeName: "Untrusted" }],
    [{}],
  ])("rejects malformed or expanded check-in bodies", async (body) => {
    const response = await POST(request(body), context);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "INVALID_CHECK_IN_REQUEST",
    });
    expect(mocks.checkInAttendee).not.toHaveBeenCalled();
  });

  it.each([
    ["ATTENDEE_NOT_FOUND", 404],
    ["REGISTRATION_NOT_ELIGIBLE", 409],
    ["IDEMPOTENCY_KEY_REUSED", 409],
    ["CHECK_IN_OPERATION_CONFLICT", 409],
  ])("maps %s to a recoverable HTTP %i response", async (code, status) => {
    mocks.checkInAttendee.mockRejectedValue(
      new mocks.CheckInOperationError(code, "Review and retry."),
    );

    const response = await POST(request({ idempotencyKey }), context);

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      error: code,
      message: "Review and retry.",
    });
  });

  it("rejects cross-origin mutations before authorization", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(
      Response.json({ error: "CROSS_ORIGIN_REQUEST_REJECTED" }, { status: 403 }),
    );

    const response = await POST(request({ idempotencyKey }), context);

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.requirePermission).not.toHaveBeenCalled();
  });

  it("keeps undo explicit and separate from the offline POST queue", async () => {
    mocks.undoCheckIn.mockResolvedValue({
      id: "checkin_1",
      undoneAt: new Date("2026-07-23T14:10:00.000Z"),
    });
    const response = await DELETE(new Request(
      "https://events.imsda.test/api/events/event_123/attendees/attendee_123/check-in",
      {
        method: "DELETE",
        headers: { origin: "https://events.imsda.test" },
      },
    ), context);

    expect(response.status).toBe(200);
    expect(mocks.undoCheckIn).toHaveBeenCalledWith(
      "event_123",
      "attendee_123",
      "staff_1",
    );
  });
});

