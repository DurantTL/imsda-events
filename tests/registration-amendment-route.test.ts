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

  class MockRegistrationAmendmentError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly issues: unknown[] = [],
      public readonly details: Record<string, unknown> = {},
    ) {
      super(message);
    }
  }

  return {
    AccessDeniedError: MockAccessDeniedError,
    RegistrationAmendmentError: MockRegistrationAmendmentError,
    requirePermission: vi.fn(),
    getCurrentSession: vi.fn(),
    rejectCrossOriginRequest: vi.fn(),
    findActiveMembership: vi.fn(),
    previewRegistrationAmendment: vi.fn(),
    amendRegistration: vi.fn(),
    logError: vi.fn(),
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
vi.mock("@/modules/registrations/amendments-repository", () => ({
  RegistrationAmendmentError: mocks.RegistrationAmendmentError,
  previewRegistrationAmendment: mocks.previewRegistrationAmendment,
  amendRegistration: mocks.amendRegistration,
}));
vi.mock("@/lib/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logger")>();
  return {
    ...actual,
    logError: mocks.logError,
  };
});

import { POST } from "@/app/api/events/[eventId]/registrations/[registrationId]/amendment/route";

const attendee = {
  attendeeId: "attendee-1",
  clientId: "existing-attendee-1",
  responses: {
    firstName: "Morgan",
    lastName: "Lee",
    shirtSize: "Adult M",
  },
};

const baseBody = {
  clientRequestId: "1616c563-e266-44b4-8c9a-d77e88ac3923",
  expectedUpdatedAt: "2026-07-27T18:00:00.000Z",
  reason: "Corrected shirt size.",
  responses: { church: "Ames SDA Church" },
  attendees: [attendee],
  previewOnly: true,
};

function request(
  body: Record<string, unknown>,
  options: { contentType?: string; origin?: string } = {},
) {
  return new Request(
    "https://events.imsda.test/api/events/event-1/registrations/registration-1/amendment",
    {
      method: "POST",
      headers: {
        origin: options.origin ?? "https://events.imsda.test",
        ...(options.contentType === undefined
          ? { "content-type": "application/json; charset=utf-8" }
          : options.contentType
            ? { "content-type": options.contentType }
            : {}),
      },
      body: JSON.stringify(body),
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
  mocks.getCurrentSession.mockResolvedValue({
    user: { id: "user-1", displayName: "Staff User" },
  });
  mocks.requirePermission.mockResolvedValue({
    user: { id: "user-1", displayName: "Staff User" },
  });
  mocks.previewRegistrationAmendment.mockResolvedValue({
    attendeeCountBefore: 1,
    attendeeCountAfter: 1,
    totalAmountCentsBefore: 12500,
    totalAmountCentsAfter: 12500,
    balanceDueCentsAfter: 12500,
    quoteFingerprint: "a".repeat(64),
  });
  mocks.amendRegistration.mockResolvedValue({
    registration: { id: "registration-1" },
    operation: { id: "operation-1", type: "AMENDMENT" },
  });
});

describe("registration amendment route", () => {
  it("requires same-origin application/json before authorizing", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValueOnce(
      Response.json({ error: "CROSS_ORIGIN_REQUEST_BLOCKED" }, { status: 403 }),
    );

    const crossOrigin = await POST(
      request(baseBody, { origin: "https://attacker.example" }),
      context,
    );
    const wrongMedia = await POST(
      request(baseBody, { contentType: "text/plain" }),
      context,
    );

    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.headers.get("cache-control")).toBe("no-store");
    expect(wrongMedia.status).toBe(415);
    expect(mocks.requirePermission).not.toHaveBeenCalled();
    expect(mocks.previewRegistrationAmendment).not.toHaveBeenCalled();
  });

  it("authorizes and returns a non-mutating preview quote", async () => {
    const response = await POST(request(baseBody), context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.requirePermission).toHaveBeenCalledWith(
      expect.anything(),
      "event-1",
      "MANAGE_REGISTRATION",
      mocks.findActiveMembership,
    );
    expect(mocks.previewRegistrationAmendment).toHaveBeenCalledWith(
      "event-1",
      "registration-1",
      baseBody,
    );
    expect(mocks.amendRegistration).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      preview: expect.objectContaining({
        quoteFingerprint: "a".repeat(64),
      }),
    });
  });

  it("commits a quoted amendment with the authorized staff actor", async () => {
    const commitBody = {
      ...baseBody,
      previewOnly: false,
      quoteFingerprint: "a".repeat(64),
    };
    const response = await POST(request(commitBody), context);

    expect(response.status).toBe(200);
    expect(mocks.amendRegistration).toHaveBeenCalledWith(
      "event-1",
      "registration-1",
      commitBody,
      { id: "user-1", displayName: "Staff User" },
    );
    expect(mocks.previewRegistrationAmendment).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      registration: { id: "registration-1" },
      operation: { id: "operation-1", type: "AMENDMENT" },
    });
  });

  it("maps amendment conflicts to typed no-store responses", async () => {
    mocks.amendRegistration.mockRejectedValue(
      new mocks.RegistrationAmendmentError(
        "STALE_REGISTRATION",
        "This registration changed after the quote was prepared.",
        [],
        { expectedUpdatedAt: baseBody.expectedUpdatedAt },
      ),
    );

    const response = await POST(
      request({
        ...baseBody,
        previewOnly: false,
        quoteFingerprint: "a".repeat(64),
      }),
      context,
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "STALE_REGISTRATION",
      message: "This registration changed after the quote was prepared.",
      issues: [],
      details: { expectedUpdatedAt: baseBody.expectedUpdatedAt },
    });
  });
});
