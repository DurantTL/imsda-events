import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rejectCrossOriginRequest: vi.fn(),
  updatePublicTieredAttendeeAnswers: vi.fn(),
  checkPublicManageRateLimit: vi.fn(),
}));

vi.mock("@/modules/access/request-security", () => ({
  rejectCrossOriginRequest: mocks.rejectCrossOriginRequest,
}));
vi.mock("@/modules/public-access/repository", () => ({
  updatePublicTieredAttendeeAnswers: mocks.updatePublicTieredAttendeeAnswers,
}));
vi.mock("@/modules/rate-limit/service", () => ({
  checkPublicManageRateLimit: mocks.checkPublicManageRateLimit,
}));

import { PUT } from "@/app/api/public/manage/[token]/answers/route";

const context = { params: Promise.resolve({ token: "private-token" }) };

function outcome(allowed: boolean) {
  return {
    allowed,
    decisions: [{
      policy: "public.manage.update.client-token",
      allowed,
      limit: 20,
      remaining: allowed ? 19 : 0,
      count: allowed ? 1 : 21,
      windowSeconds: 900,
      resetAfterSeconds: 600,
    }],
  };
}

function request(body: unknown) {
  return new Request(
    "https://events.imsda.test/api/public/manage/private-token/answers",
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
  mocks.checkPublicManageRateLimit.mockResolvedValue(outcome(true));
  mocks.updatePublicTieredAttendeeAnswers.mockResolvedValue({
    expectedUpdatedAt: "2026-07-30T11:00:00.000Z",
    attendees: [],
  });
});

describe("private registration answer route", () => {
  it("authorizes by private token and passes a validated optimistic update", async () => {
    const input = {
      clientRequestId: "93bc4ffb-81b1-47cb-888d-693759258938",
      expectedUpdatedAt: "2026-07-30T10:00:00.000Z",
      attendees: [{
        attendeeId: "attendee-1",
        responses: { session_preferences: ["Service", "Prayer"] },
      }],
    };
    const response = await PUT(request(input), context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.checkPublicManageRateLimit)
      .toHaveBeenCalledWith(expect.any(Request), "private-token", "update");
    expect(mocks.updatePublicTieredAttendeeAnswers)
      .toHaveBeenCalledWith("private-token", input);
  });

  it("rate limits before attempting a private-link update", async () => {
    mocks.checkPublicManageRateLimit.mockResolvedValue(outcome(false));
    const response = await PUT(request({
      clientRequestId: "df8c41a9-f908-4d73-b38c-900b45acfaef",
      expectedUpdatedAt: "2026-07-30T10:00:00.000Z",
      attendees: [{ attendeeId: "attendee-1", responses: {} }],
    }), context);

    expect(response.status).toBe(429);
    expect(mocks.updatePublicTieredAttendeeAnswers).not.toHaveBeenCalled();
  });

  it("returns the same unavailable response for an invalid or expired private link", async () => {
    mocks.updatePublicTieredAttendeeAnswers.mockResolvedValue(null);
    const response = await PUT(request({
      clientRequestId: "2d340092-e41a-49c1-85d4-a55717324002",
      expectedUpdatedAt: "2026-07-30T10:00:00.000Z",
      attendees: [{ attendeeId: "attendee-1", responses: {} }],
    }), context);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "REGISTRATION_ACCESS_UNAVAILABLE",
    });
  });
});
