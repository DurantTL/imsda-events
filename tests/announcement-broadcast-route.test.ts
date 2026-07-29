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
  class MockAnnouncementBroadcastError extends Error {
    constructor(
      public readonly code:
        | "ANNOUNCEMENT_NOT_FOUND"
        | "ANNOUNCEMENT_NOT_PUBLISHED"
        | "NO_ACTIVE_REGISTRATIONS",
      message: string,
    ) {
      super(message);
    }
  }
  return {
    AccessDeniedError: MockAccessDeniedError,
    AnnouncementBroadcastError: MockAnnouncementBroadcastError,
    requirePermission: vi.fn(),
    getCurrentSession: vi.fn(),
    rejectCrossOriginRequest: vi.fn(),
    findActiveMembership: vi.fn(),
    broadcastPublishedAnnouncement: vi.fn(),
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
vi.mock("@/modules/communications/announcement-broadcast", () => ({
  AnnouncementBroadcastError: mocks.AnnouncementBroadcastError,
  broadcastPublishedAnnouncement: mocks.broadcastPublishedAnnouncement,
}));

import { POST } from "@/app/api/events/[eventId]/announcements/[announcementId]/broadcast/route";

const batchId = "2d037129-32a3-4935-a4ce-b08a1d92cb6a";
const context = {
  params: Promise.resolve({
    eventId: "event-1",
    announcementId: "announcement-1",
  }),
};

function request(body: unknown = { batchId }) {
  return new Request(
    "https://events.imsda.test/api/events/event-1/announcements/announcement-1/broadcast",
    {
      method: "POST",
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
  mocks.getCurrentSession.mockResolvedValue({ user: { id: "staff-1" } });
  mocks.requirePermission.mockResolvedValue({ user: { id: "staff-1" } });
  mocks.broadcastPublishedAnnouncement.mockResolvedValue({
    broadcastId: batchId,
    announcementId: "announcement-1",
    messageCount: 3,
    skippedCount: 0,
    deliveryMode: "LOCAL_CAPTURE",
  });
});

describe("announcement broadcast route", () => {
  it("requires event communication access and a stable client batch ID", async () => {
    const response = await POST(request(), context);

    expect(response.status).toBe(200);
    expect(mocks.requirePermission).toHaveBeenCalledWith(
      { user: { id: "staff-1" } },
      "event-1",
      "MANAGE_COMMUNICATIONS",
      mocks.findActiveMembership,
    );
    expect(mocks.broadcastPublishedAnnouncement).toHaveBeenCalledWith({
      eventId: "event-1",
      announcementId: "announcement-1",
      batchId,
      actorUserId: "staff-1",
    });
  });

  it("rejects cross-origin requests before authorization or delivery", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(
      Response.json({ error: "CROSS_ORIGIN_REQUEST" }, { status: 403 }),
    );

    const response = await POST(request(), context);

    expect(response.status).toBe(403);
    expect(mocks.requirePermission).not.toHaveBeenCalled();
    expect(mocks.broadcastPublishedAnnouncement).not.toHaveBeenCalled();
  });

  it("rejects an invalid batch ID without creating messages", async () => {
    const response = await POST(request({ batchId: "not-a-uuid" }), context);

    expect(response.status).toBe(400);
    expect(mocks.broadcastPublishedAnnouncement).not.toHaveBeenCalled();
  });
});
