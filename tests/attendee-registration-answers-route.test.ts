import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rejectCrossOriginRequest: vi.fn(),
  getCurrentAttendee: vi.fn(),
  updateTieredAttendeeAnswers: vi.fn(),
}));

vi.mock("@/modules/access/request-security", () => ({
  rejectCrossOriginRequest: mocks.rejectCrossOriginRequest,
}));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({
  getCurrentAttendee: mocks.getCurrentAttendee,
}));
vi.mock("@/modules/attendee-accounts/registrations-repository", () => ({
  updateTieredAttendeeAnswers: mocks.updateTieredAttendeeAnswers,
}));

import { PUT } from "@/app/api/attendee/registrations/[registrationId]/answers/route";

const context = {
  params: Promise.resolve({ registrationId: "registration-1" }),
};

function request(body: unknown) {
  return new Request(
    "https://events.imsda.test/api/attendee/registrations/registration-1/answers",
    {
      method: "PUT",
      headers: {
        origin: "https://events.imsda.test",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.getCurrentAttendee.mockResolvedValue({
    account: {
      id: "account-1",
      verifiedEmail: "guest@example.test",
      displayName: "Guest",
    },
    via: "attendee",
  });
  mocks.updateTieredAttendeeAnswers.mockResolvedValue({
    updatedAt: "2026-07-29T16:00:00.000Z",
  });
});

describe("attendee registration answer route", () => {
  it("passes only a verified attendee identity and validated payload to the repository", async () => {
    const response = await PUT(request({
      expectedUpdatedAt: "2026-07-29T15:00:00.000Z",
      attendees: [{
        attendeeId: "attendee-1",
        responses: { meal_choice: "Vegetarian" },
      }],
    }), context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.updateTieredAttendeeAnswers).toHaveBeenCalledWith({
      accountId: "account-1",
      verifiedEmail: "guest@example.test",
      registrationId: "registration-1",
      expectedUpdatedAt: "2026-07-29T15:00:00.000Z",
      attendees: [{
        attendeeId: "attendee-1",
        responses: { meal_choice: "Vegetarian" },
      }],
    });
  });

  it("does not let the staff-session fallback mutate attendee answers", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({
      account: {
        id: "account-1",
        verifiedEmail: "staff@example.test",
        displayName: "Staff",
      },
      via: "staff",
    });

    const response = await PUT(request({
      expectedUpdatedAt: "2026-07-29T15:00:00.000Z",
      attendees: [{ attendeeId: "attendee-1", responses: {} }],
    }), context);

    expect(response.status).toBe(401);
    expect(mocks.updateTieredAttendeeAnswers).not.toHaveBeenCalled();
  });

  it("rejects cross-origin requests before resolving attendee identity", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(
      Response.json({ error: "CROSS_ORIGIN_REQUEST" }, { status: 403 }),
    );

    const response = await PUT(request({
      expectedUpdatedAt: "2026-07-29T15:00:00.000Z",
      attendees: [{ attendeeId: "attendee-1", responses: {} }],
    }), context);

    expect(response.status).toBe(403);
    expect(mocks.getCurrentAttendee).not.toHaveBeenCalled();
    expect(mocks.updateTieredAttendeeAnswers).not.toHaveBeenCalled();
  });
});
