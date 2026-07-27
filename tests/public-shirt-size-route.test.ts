import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockPublicShirtSizeConfirmationError extends Error {
    constructor(
      public readonly code:
        | "REGISTRATION_NOT_ELIGIBLE"
        | "ATTENDEE_ROSTER_CHANGED",
      message: string,
    ) {
      super(message);
    }
  }
  return {
    rejectCrossOriginRequest: vi.fn(),
    confirmPublicRegistrationShirtSizes: vi.fn(),
    checkPublicManageRateLimit: vi.fn(),
    PublicShirtSizeConfirmationError:
      MockPublicShirtSizeConfirmationError,
  };
});

vi.mock("@/modules/access/request-security", () => ({
  rejectCrossOriginRequest: mocks.rejectCrossOriginRequest,
}));
vi.mock("@/modules/public-access/repository", () => ({
  confirmPublicRegistrationShirtSizes:
    mocks.confirmPublicRegistrationShirtSizes,
  PublicShirtSizeConfirmationError:
    mocks.PublicShirtSizeConfirmationError,
}));
vi.mock("@/modules/rate-limit/service", () => ({
  checkPublicManageRateLimit: mocks.checkPublicManageRateLimit,
}));

import { PATCH } from "@/app/api/public/manage/[token]/shirt-sizes/route";

const token = "a".repeat(43);
const context = { params: Promise.resolve({ token }) };
const body = {
  attendees: [
    { attendeeId: "attendee-1", shirtSize: "Adult L" },
    { attendeeId: "attendee-2", shirtSize: "Youth M" },
  ],
};

function patchRequest(
  value: unknown,
  origin = "https://events.imsda.test",
) {
  return new Request(
    `https://events.imsda.test/api/public/manage/${token}/shirt-sizes`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify(value),
    },
  );
}

function rateLimitOutcome(allowed: boolean) {
  return {
    allowed,
    decisions: [{
      policy: "public.manage.update.client-token",
      allowed,
      limit: 10,
      remaining: allowed ? 9 : 0,
      count: allowed ? 1 : 11,
      windowSeconds: 900,
      resetAfterSeconds: 177,
    }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.checkPublicManageRateLimit.mockResolvedValue(
    rateLimitOutcome(true),
  );
  mocks.confirmPublicRegistrationShirtSizes.mockResolvedValue({
    attendees: body.attendees.map((attendee) => ({
      id: attendee.attendeeId,
      name: `Guest ${attendee.attendeeId}`,
      shirtSize: attendee.shirtSize,
      shirtSizeConfirmedAt: "2026-08-02T15:30:00.000Z",
    })),
  });
});

describe("public shirt-size confirmation route", () => {
  it("confirms only the strict attendee and shirt-size payload", async () => {
    const response = await PATCH(patchRequest(body), context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(mocks.checkPublicManageRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      token,
      "update",
    );
    expect(mocks.confirmPublicRegistrationShirtSizes)
      .toHaveBeenCalledWith(token, body);
    expect(await response.json()).toMatchObject({
      registration: {
        attendees: [
          { id: "attendee-1", shirtSize: "Adult L" },
          { id: "attendee-2", shirtSize: "Youth M" },
        ],
      },
    });
  });

  it("rejects unknown fields and unsupported sizes before saving", async () => {
    const extraField = await PATCH(patchRequest({
      ...body,
      status: "CONFIRMED",
    }), context);
    expect(extraField.status).toBe(400);

    const invalidSize = await PATCH(patchRequest({
      attendees: [{ attendeeId: "attendee-1", shirtSize: "Custom" }],
    }), context);
    expect(invalidSize.status).toBe(400);
    expect(mocks.confirmPublicRegistrationShirtSizes)
      .not.toHaveBeenCalled();
  });

  it("returns a conflict when the attendee roster changed", async () => {
    mocks.confirmPublicRegistrationShirtSizes.mockRejectedValue(
      new mocks.PublicShirtSizeConfirmationError(
        "ATTENDEE_ROSTER_CHANGED",
        "Refresh before confirming again.",
      ),
    );

    const response = await PATCH(patchRequest(body), context);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "ATTENDEE_ROSTER_CHANGED",
      message: "Refresh before confirming again.",
    });
  });

  it("rejects cross-origin and rate-limited writes before saving", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValueOnce(
      Response.json({ error: "INVALID_REQUEST_ORIGIN" }, { status: 403 }),
    );
    const crossOrigin = await PATCH(
      patchRequest(body, "https://untrusted.example"),
      context,
    );
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.headers.get("cache-control")).toContain("no-store");
    expect(mocks.confirmPublicRegistrationShirtSizes)
      .not.toHaveBeenCalled();

    mocks.rejectCrossOriginRequest.mockReturnValue(null);
    mocks.checkPublicManageRateLimit.mockResolvedValue(
      rateLimitOutcome(false),
    );
    const limited = await PATCH(patchRequest(body), context);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("177");
    expect(mocks.confirmPublicRegistrationShirtSizes)
      .not.toHaveBeenCalled();
  });

  it("uses the generic unavailable response for an inactive private link", async () => {
    mocks.confirmPublicRegistrationShirtSizes.mockResolvedValue(null);

    const response = await PATCH(patchRequest(body), context);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "REGISTRATION_ACCESS_UNAVAILABLE",
      message: "This private registration link is invalid or no longer active.",
    });
  });
});
