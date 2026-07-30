import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockAccessDeniedError extends Error {
    constructor(
      message: string,
      public readonly status = 403,
      public readonly code = "PERMISSION_DENIED",
    ) {
      super(message);
    }
  }
  return {
    AccessDeniedError: MockAccessDeniedError,
    rejectCrossOriginRequest: vi.fn(),
    getCurrentAttendee: vi.fn(),
    getCurrentSession: vi.fn(),
    requirePermission: vi.fn(),
    findActiveMembership: vi.fn(),
    acceptCommunityConduct: vi.fn(),
    updateCommunityNotifications: vi.fn(),
    createCommunityPost: vi.fn(),
    reportCommunityPost: vi.fn(),
    markCommunityNotificationsRead: vi.fn(),
    updateCommunitySettings: vi.fn(),
    moderateCommunityPost: vi.fn(),
    resolveCommunityReport: vi.fn(),
  };
});

vi.mock("@/modules/access/request-security", () => ({
  rejectCrossOriginRequest: mocks.rejectCrossOriginRequest,
}));
vi.mock("@/modules/access/current-session", () => ({
  getCurrentSession: mocks.getCurrentSession,
}));
vi.mock("@/modules/access/authorization", () => ({
  AccessDeniedError: mocks.AccessDeniedError,
  requirePermission: mocks.requirePermission,
}));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({
  getCurrentAttendee: mocks.getCurrentAttendee,
}));
vi.mock("@/modules/events/repository", () => ({
  findActiveMembership: mocks.findActiveMembership,
}));
vi.mock("@/modules/community/repository", () => ({
  CommunityError: class CommunityError extends Error {},
  acceptCommunityConduct: mocks.acceptCommunityConduct,
  updateCommunityNotifications: mocks.updateCommunityNotifications,
  createCommunityPost: mocks.createCommunityPost,
  reportCommunityPost: mocks.reportCommunityPost,
  markCommunityNotificationsRead: mocks.markCommunityNotificationsRead,
  updateCommunitySettings: mocks.updateCommunitySettings,
  moderateCommunityPost: mocks.moderateCommunityPost,
  resolveCommunityReport: mocks.resolveCommunityReport,
}));

import { POST as attendeePost } from "@/app/api/attendee/events/[eventId]/community/route";
import { PATCH as staffPatch } from "@/app/api/events/[eventId]/community/route";

const context = { params: Promise.resolve({ eventId: "event-1" }) };
const account = {
  id: "account-1",
  verifiedEmail: "attendee@example.org",
  displayName: "Attendee One",
};

function request(method: "POST" | "PATCH", body: unknown) {
  return new Request("https://events.imsda.test/api/community", {
    method,
    headers: {
      origin: "https://events.imsda.test",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.getCurrentAttendee.mockResolvedValue({ account, via: "attendee", sessionId: "session-1" });
  mocks.getCurrentSession.mockResolvedValue({ user: { id: "staff-1" } });
  mocks.requirePermission.mockResolvedValue({ user: { id: "staff-1" } });
});

describe("attendee community route", () => {
  it("creates an event-scoped post for a signed-in attendee", async () => {
    const response = await attendeePost(request("POST", {
      action: "CREATE_POST",
      body: "Does anyone need help carrying bags?",
      parentId: null,
    }), context);

    expect(response.status).toBe(200);
    expect(mocks.createCommunityPost).toHaveBeenCalledWith(account, "event-1", {
      action: "CREATE_POST",
      body: "Does anyone need help carrying bags?",
      parentId: null,
    });
  });

  it("does not let the staff attendee bridge post as a registrant", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account, via: "staff", sessionId: null });
    const response = await attendeePost(request("POST", {
      action: "ACCEPT_CONDUCT",
    }), context);

    expect(response.status).toBe(401);
    expect(mocks.acceptCommunityConduct).not.toHaveBeenCalled();
  });

  it("rejects cross-origin mutations before reading attendee identity", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(
      Response.json({ error: "CROSS_ORIGIN_REQUEST" }, { status: 403 }),
    );
    const response = await attendeePost(request("POST", {
      action: "ACCEPT_CONDUCT",
    }), context);

    expect(response.status).toBe(403);
    expect(mocks.getCurrentAttendee).not.toHaveBeenCalled();
  });
});
describe("staff community route", () => {
  it("requires communications permission before enabling discussion", async () => {
    const input = {
      action: "UPDATE_SETTINGS",
      isEnabled: true,
      allowNewPosts: true,
      allowReplies: true,
      conductText: "Be kind, protect privacy, respect one another, and keep every post focused on the retreat.",
      retentionDays: 30,
    };
    const response = await staffPatch(request("PATCH", input), context);

    expect(response.status).toBe(200);
    expect(mocks.requirePermission).toHaveBeenCalledWith(
      { user: { id: "staff-1" } },
      "event-1",
      "MANAGE_COMMUNICATIONS",
      mocks.findActiveMembership,
    );
    expect(mocks.updateCommunitySettings).toHaveBeenCalledWith("event-1", "staff-1", input);
  });
});
