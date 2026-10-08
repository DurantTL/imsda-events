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
  class MockMessagingError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly details?: Record<string, unknown>,
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
    MessagingError: MockMessagingError,
    MessageFileError: MockMessageFileError,
    requirePermission: vi.fn(),
    getCurrentSession: vi.fn(),
    rejectCrossOriginRequest: vi.fn(),
    findActiveMembership: vi.fn(),
    enqueueSelectedAudienceBatch: vi.fn(),
    getSelectedAudiencePreview: vi.fn(),
  };
});

vi.mock("@/modules/access/authorization", () => ({
  AccessDeniedError: mocks.AccessDeniedError,
  requirePermission: mocks.requirePermission,
}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: mocks.findActiveMembership }));
vi.mock("@/modules/communications/message-files", () => ({ MessageFileError: mocks.MessageFileError }));
vi.mock("@/modules/communications/messaging-repository", () => ({
  MessagingError: mocks.MessagingError,
  enqueueSelectedAudienceBatch: mocks.enqueueSelectedAudienceBatch,
  getSelectedAudiencePreview: mocks.getSelectedAudiencePreview,
}));

import { POST } from "@/app/api/events/[eventId]/selected-audience-messages/route";

const batchId = "2d037129-32a3-4935-a4ce-b08a1d92cb6a";
const context = { params: Promise.resolve({ eventId: "event-1" }) };

function request(body: unknown) {
  return new Request("https://events.imsda.test/api/events/event-1/selected-audience-messages", {
    method: "POST",
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.getCurrentSession.mockResolvedValue({ user: { id: "staff-1" } });
  mocks.requirePermission.mockResolvedValue({ user: { id: "staff-1" } });
  mocks.getSelectedAudiencePreview.mockResolvedValue({ templateKey: "CUSTOM_MESSAGE", fingerprint: "a".repeat(64) });
  mocks.enqueueSelectedAudienceBatch.mockResolvedValue({ batchId, includedCount: 1 });
});

describe("selected-audience route and the custom message", () => {
  it("previews the custom message for the chosen registrations, behind communications access", async () => {
    const response = await POST(request({
      mode: "preview",
      templateKey: "CUSTOM_MESSAGE",
      registrationIds: ["registration-1"],
    }), context);

    expect(response.status).toBe(200);
    expect(mocks.requirePermission).toHaveBeenCalledWith(
      { user: { id: "staff-1" } },
      "event-1",
      "MANAGE_COMMUNICATIONS",
      mocks.findActiveMembership,
    );
    expect(mocks.getSelectedAudiencePreview).toHaveBeenCalledWith("event-1", "CUSTOM_MESSAGE", ["registration-1"]);
  });

  it("sends the custom message with no title or message text", async () => {
    const response = await POST(request({
      batchId,
      templateKey: "CUSTOM_MESSAGE",
      registrationIds: ["registration-1"],
      previewFingerprint: "a".repeat(64),
    }), context);

    expect(response.status).toBe(201);
    expect(mocks.enqueueSelectedAudienceBatch).toHaveBeenCalledWith(
      "event-1",
      expect.objectContaining({ templateKey: "CUSTOM_MESSAGE", announcementTitle: "", announcementBody: "" }),
      "staff-1",
    );
  });

  it("says plainly when the template has not been published", async () => {
    mocks.enqueueSelectedAudienceBatch.mockRejectedValue(
      new mocks.MessagingError("TEMPLATE_NOT_PUBLISHED", "The Custom message template has not been published for this event."),
    );
    const response = await POST(request({
      batchId,
      templateKey: "CUSTOM_MESSAGE",
      registrationIds: ["registration-1"],
      previewFingerprint: "a".repeat(64),
    }), context);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "TEMPLATE_NOT_PUBLISHED" });
  });

  it("still requires a title and message for the event announcement", async () => {
    const response = await POST(request({
      batchId,
      templateKey: "EVENT_ANNOUNCEMENT",
      registrationIds: ["registration-1"],
      previewFingerprint: "a".repeat(64),
    }), context);

    expect(response.status).toBe(400);
    expect(mocks.enqueueSelectedAudienceBatch).not.toHaveBeenCalled();
  });

  it("refuses a template that is not offered for hand-sending", async () => {
    const response = await POST(request({
      mode: "preview",
      templateKey: "REFUND_NOTICE",
      registrationIds: ["registration-1"],
    }), context);

    expect(response.status).toBe(400);
  });
});
