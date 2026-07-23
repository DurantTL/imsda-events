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
  class MockRegistrationLifecycleError extends Error {
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
    RegistrationLifecycleError: MockRegistrationLifecycleError,
    requirePermission: vi.fn(),
    getCurrentSession: vi.fn(),
    rejectCrossOriginRequest: vi.fn(),
    findActiveMembership: vi.fn(),
    cancelRegistration: vi.fn(),
    reactivateRegistration: vi.fn(),
    moveRegistrationToWaitlist: vi.fn(),
    promoteRegistrationFromWaitlist: vi.fn(),
    processQueuedMessageIdsAfterCommit: vi.fn(),
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
vi.mock("@/modules/communications/messaging-repository", () => ({
  processQueuedMessageIdsAfterCommit: mocks.processQueuedMessageIdsAfterCommit,
}));
vi.mock("@/modules/registrations/lifecycle-repository", () => ({
  RegistrationLifecycleError: mocks.RegistrationLifecycleError,
  cancelRegistration: mocks.cancelRegistration,
  reactivateRegistration: mocks.reactivateRegistration,
  moveRegistrationToWaitlist: mocks.moveRegistrationToWaitlist,
  promoteRegistrationFromWaitlist: mocks.promoteRegistrationFromWaitlist,
}));

import { POST } from "@/app/api/events/[eventId]/registrations/[registrationId]/lifecycle/[action]/route";

function request(body: Record<string, unknown> = {}) {
  return new Request(
    "https://events.imsda.test/api/events/event-1/registrations/registration-1/lifecycle/cancel",
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

function context(action: string) {
  return {
    params: Promise.resolve({
      eventId: "event-1",
      registrationId: "registration-1",
      action,
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.getCurrentSession.mockResolvedValue({ user: { id: "user-1" } });
  mocks.requirePermission.mockResolvedValue({ user: { id: "user-1" } });
  mocks.cancelRegistration.mockResolvedValue({
    registration: { id: "registration-1", status: "CANCELLED" },
    autoPromotedRegistration: null,
    pendingMessageIds: ["message-cancelled"],
  });
  mocks.reactivateRegistration.mockResolvedValue({ id: "registration-1", status: "SUBMITTED" });
  mocks.moveRegistrationToWaitlist.mockResolvedValue({
    registration: { id: "registration-1", status: "WAITLISTED" },
    pendingMessageIds: ["message-waitlisted"],
  });
  mocks.promoteRegistrationFromWaitlist.mockResolvedValue({
    registration: { id: "registration-1", status: "SUBMITTED" },
    pendingMessageIds: ["message-promoted"],
  });
  mocks.processQueuedMessageIdsAfterCommit.mockResolvedValue({});
});

describe("registration lifecycle action route", () => {
  it.each([
    ["cancel", mocks.cancelRegistration],
    ["reactivate", mocks.reactivateRegistration],
    ["waitlist", mocks.moveRegistrationToWaitlist],
    ["promote", mocks.promoteRegistrationFromWaitlist],
  ])("authorizes and dispatches the %s action", async (action, operation) => {
    const response = await POST(request({ reason: "Reviewed by event staff." }), context(action));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.requirePermission).toHaveBeenCalledWith(
      { user: { id: "user-1" } },
      "event-1",
      "MANAGE_REGISTRATION",
      mocks.findActiveMembership,
    );
    expect(operation).toHaveBeenCalledWith(
      "event-1",
      "registration-1",
      "user-1",
      "Reviewed by event staff.",
    );
    if (action !== "reactivate") {
      expect(mocks.processQueuedMessageIdsAfterCommit).toHaveBeenCalledOnce();
    }
  });

  it("does not roll back a completed lifecycle response when message processing fails", async () => {
    mocks.processQueuedMessageIdsAfterCommit.mockRejectedValue(new Error("provider unavailable"));
    const response = await POST(
      request({ reason: "Reviewed by event staff." }),
      context("cancel"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      registration: { status: "CANCELLED" },
    });
  });

  it("returns 404 for an unsupported lifecycle action", async () => {
    const response = await POST(request(), context("confirm"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "LIFECYCLE_ACTION_NOT_FOUND" });
    expect(mocks.requirePermission).not.toHaveBeenCalled();
  });

  it("returns a typed conflict when capacity blocks promotion", async () => {
    mocks.promoteRegistrationFromWaitlist.mockRejectedValue(
      new mocks.RegistrationLifecycleError(
        "OPTION_CAPACITY_UNAVAILABLE",
        "Cabin is full.",
        { optionValue: "Cabin", remaining: 0 },
      ),
    );

    const response = await POST(request({ reason: "Manual review." }), context("promote"));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "OPTION_CAPACITY_UNAVAILABLE",
      message: "Cabin is full.",
      details: { optionValue: "Cabin", remaining: 0 },
    });
  });
});
