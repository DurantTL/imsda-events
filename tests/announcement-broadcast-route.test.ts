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
        | "NO_ACTIVE_REGISTRATIONS"
        | "PREVIEW_REQUIRED"
        | "PREVIEW_CHANGED",
      message: string,
    ) {
      super(message);
    }
  }
  class MockMessageFileError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    AccessDeniedError: MockAccessDeniedError,
    MessageFileError: MockMessageFileError,
    AnnouncementBroadcastError: MockAnnouncementBroadcastError,
    requirePermission: vi.fn(),
    getCurrentSession: vi.fn(),
    rejectCrossOriginRequest: vi.fn(),
    findActiveMembership: vi.fn(),
    broadcastPublishedAnnouncement: vi.fn(),
    previewAnnouncementBroadcast: vi.fn(),
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
vi.mock("@/modules/communications/message-files", () => ({ MessageFileError: mocks.MessageFileError }));
vi.mock("@/modules/communications/announcement-broadcast", () => ({
  AnnouncementBroadcastError: mocks.AnnouncementBroadcastError,
  broadcastPublishedAnnouncement: mocks.broadcastPublishedAnnouncement,
  previewAnnouncementBroadcast: mocks.previewAnnouncementBroadcast,
}));

import { POST } from "@/app/api/events/[eventId]/announcements/[announcementId]/broadcast/route";

const batchId = "2d037129-32a3-4935-a4ce-b08a1d92cb6a";
const previewFingerprint = "a".repeat(64);
const context = {
  params: Promise.resolve({
    eventId: "event-1",
    announcementId: "announcement-1",
  }),
};

function request(body: unknown = { batchId, previewFingerprint }) {
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
  mocks.previewAnnouncementBroadcast.mockResolvedValue({
    announcementId: "announcement-1",
    title: "Friday arrival information",
    audienceLabel: "All active registrations (submitted or confirmed) for this event",
    activeRegistrationCount: 3,
    recipientCount: 3,
    skippedNoEmailCount: 0,
    deliveryMode: "LOCAL_CAPTURE",
    templateEnabled: true,
    suppressed: false,
    fingerprint: previewFingerprint,
    sendTiming: "IMMEDIATE",
    generatedAt: "2026-09-28T04:06:05.000Z",
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
      previewFingerprint,
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

  it("returns a recipient-count and audience review without sending anything (#472)", async () => {
    const response = await POST(request({ mode: "preview" }), context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.requirePermission).toHaveBeenCalledWith(
      { user: { id: "staff-1" } },
      "event-1",
      "MANAGE_COMMUNICATIONS",
      mocks.findActiveMembership,
    );
    expect(mocks.previewAnnouncementBroadcast).toHaveBeenCalledWith({
      eventId: "event-1",
      announcementId: "announcement-1",
    });
    expect(mocks.broadcastPublishedAnnouncement).not.toHaveBeenCalled();
    expect(body.preview).toMatchObject({
      recipientCount: 3,
      audienceLabel: "All active registrations (submitted or confirmed) for this event",
      deliveryMode: "LOCAL_CAPTURE",
    });
  });

  it("still requires communications access for a preview", async () => {
    mocks.requirePermission.mockRejectedValueOnce(
      new mocks.AccessDeniedError("Communications access is required.", 403, "PERMISSION_DENIED"),
    );

    const response = await POST(request({ mode: "preview" }), context);

    expect(response.status).toBe(403);
    expect(mocks.previewAnnouncementBroadcast).not.toHaveBeenCalled();
  });

  it("refuses a send with no review fingerprint (#472)", async () => {
    const response = await POST(request({ batchId }), context);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe("PREVIEW_REQUIRED");
    expect(body.message).toMatch(/review/i);
    expect(mocks.broadcastPublishedAnnouncement).not.toHaveBeenCalled();
  });

  it("refuses a send whose review fingerprint is stale (#472)", async () => {
    mocks.broadcastPublishedAnnouncement.mockRejectedValueOnce(
      new mocks.AnnouncementBroadcastError(
        "PREVIEW_CHANGED",
        "The recipients, template, or announcement changed since you reviewed it. Review it again before sending.",
      ),
    );

    const response = await POST(request({ batchId, previewFingerprint: "b".repeat(64) }), context);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe("PREVIEW_CHANGED");
    expect(body.message).toMatch(/review it again/i);
  });

  it("sends when the fingerprint matches the review (#472)", async () => {
    const response = await POST(request({ batchId, previewFingerprint }), context);

    expect(response.status).toBe(200);
    expect(mocks.broadcastPublishedAnnouncement).toHaveBeenCalledWith(
      expect.objectContaining({ batchId, previewFingerprint }),
    );
  });

  it("answers a file problem found while queueing with a 409 and its safe message, not a 500 (#824)", async () => {
    mocks.broadcastPublishedAnnouncement.mockRejectedValueOnce(
      new mocks.MessageFileError("FILE_SET_INVALID", "A picture in the message is not one of this event's uploaded images, so the message was not queued."),
    );
    const response = await POST(request({ batchId, previewFingerprint }), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "FILE_SET_INVALID",
      message: "A picture in the message is not one of this event's uploaded images, so the message was not queued.",
    });
  });
});
