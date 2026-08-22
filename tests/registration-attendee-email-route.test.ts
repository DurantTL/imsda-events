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
    updateRegistrationAttendeeEmail: vi.fn(),
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
  updateRegistrationAttendeeEmail: mocks.updateRegistrationAttendeeEmail,
}));

import { PATCH } from "@/app/api/events/[eventId]/registrations/[registrationId]/attendees/[attendeeId]/route";

function request(email: string) {
  return new Request(
    "https://events.imsda.test/api/events/event-1/registrations/registration-1/attendees/attendee-1",
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        origin: "https://events.imsda.test",
      },
      body: JSON.stringify({ email }),
    },
  );
}

const context = {
  params: Promise.resolve({
    eventId: "event-1",
    registrationId: "registration-1",
    attendeeId: "attendee-1",
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.getCurrentSession.mockResolvedValue({ user: { id: "user-1" } });
  mocks.requirePermission.mockResolvedValue({ user: { id: "user-1" } });
  mocks.updateRegistrationAttendeeEmail.mockResolvedValue({ id: "registration-1" });
});

describe("registration attendee email route", () => {
  it("authorizes and updates the attendee's email", async () => {
    const response = await PATCH(request("attendee@example.com"), context);

    expect(response.status).toBe(200);
    expect(mocks.requirePermission).toHaveBeenCalledWith(
      { user: { id: "user-1" } },
      "event-1",
      "MANAGE_REGISTRATION",
      mocks.findActiveMembership,
    );
    expect(mocks.updateRegistrationAttendeeEmail).toHaveBeenCalledWith(
      "event-1",
      "registration-1",
      "attendee-1",
      "attendee@example.com",
      "user-1",
    );
    expect(await response.json()).toEqual({ registration: { id: "registration-1" } });
  });

  it("rejects an invalid email", async () => {
    const response = await PATCH(request("not-an-email"), context);

    expect(response.status).toBe(400);
    expect(mocks.updateRegistrationAttendeeEmail).not.toHaveBeenCalled();
  });

  it.each([
    ["ATTENDEE_NOT_FOUND", 404],
  ])("maps %s to HTTP %i", async (code, status) => {
    mocks.updateRegistrationAttendeeEmail.mockRejectedValue(
      new mocks.RegistrationAttendeeOperationError(
        code,
        "The attendee could not be found on this registration.",
      ),
    );

    const response = await PATCH(request("attendee@example.com"), context);

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      error: code,
      message: "The attendee could not be found on this registration.",
      details: {},
    });
  });
});
