import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockAccessDeniedError extends Error {
    constructor(
      public readonly code: string,
      public readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  class MockRegistrationAttendeeOperationError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly details: Record<string, unknown> = {},
    ) {
      super(message);
    }
  }
  return {
    AccessDeniedError: MockAccessDeniedError,
    RegistrationAttendeeOperationError: MockRegistrationAttendeeOperationError,
    requirePermission: vi.fn(),
    getCurrentSession: vi.fn(),
    rejectCrossOriginRequest: vi.fn(),
    findActiveMembership: vi.fn(),
    addRegistrationAttendee: vi.fn(),
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
vi.mock("@/modules/registrations/repository", () => ({
  RegistrationAttendeeOperationError: mocks.RegistrationAttendeeOperationError,
  addRegistrationAttendee: mocks.addRegistrationAttendee,
}));

import { POST } from "@/app/api/events/[eventId]/registrations/[registrationId]/attendees/route";

function request() {
  return new Request(
    "https://events.imsda.test/api/events/event-1/registrations/registration-1/attendees",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://events.imsda.test",
      },
      body: JSON.stringify({
        firstName: "Second",
        lastName: "Attendee",
        email: "",
        phone: "",
        attendeeType: "ATTENDEE",
      }),
    },
  );
}

const context = {
  params: Promise.resolve({
    eventId: "event-1",
    registrationId: "registration-1",
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.getCurrentSession.mockResolvedValue({ user: { id: "user-1" } });
  mocks.requirePermission.mockResolvedValue({ user: { id: "user-1" } });
  mocks.addRegistrationAttendee.mockResolvedValue({ id: "registration-1" });
});

describe("registration attendee route", () => {
  it("authorizes and creates an attendee", async () => {
    const response = await POST(request(), context);

    expect(response.status).toBe(201);
    expect(mocks.requirePermission).toHaveBeenCalledWith(
      { user: { id: "user-1" } },
      "event-1",
      "MANAGE_REGISTRATION",
      mocks.findActiveMembership,
    );
    expect(mocks.addRegistrationAttendee).toHaveBeenCalledWith(
      "event-1",
      "registration-1",
      expect.objectContaining({
        firstName: "Second",
        lastName: "Attendee",
      }),
      "user-1",
    );
  });

  it.each([
    ["REGISTRATION_NOT_FOUND", 404],
    ["REGISTRATION_NOT_ACTIVE", 409],
    ["PUBLIC_FORM_ATTENDEE_EDIT_REQUIRES_FORM", 409],
    ["EVENT_CAPACITY_UNAVAILABLE", 409],
  ])("maps %s to HTTP %i", async (code, status) => {
    mocks.addRegistrationAttendee.mockRejectedValue(
      new mocks.RegistrationAttendeeOperationError(
        code,
        "The attendee change is not allowed.",
        { currentStatus: "WAITLISTED" },
      ),
    );

    const response = await POST(request(), context);

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      error: code,
      message: "The attendee change is not allowed.",
      details: { currentStatus: "WAITLISTED" },
    });
  });
});
