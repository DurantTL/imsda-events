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
    constructor(public readonly code: string, message: string, public readonly details?: Record<string, unknown>) {
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
    getMessagingWorkspace: vi.fn(),
    previewFailedMessagesRetry: vi.fn(),
    retryFailedMessages: vi.fn(),
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
  getMessagingWorkspace: mocks.getMessagingWorkspace,
}));
vi.mock("@/modules/communications/retry-failed", () => ({
  previewFailedMessagesRetry: mocks.previewFailedMessagesRetry,
  retryFailedMessages: mocks.retryFailedMessages,
}));

import { GET as getMessages } from "@/app/api/events/[eventId]/messages/route";
import { GET, POST } from "@/app/api/events/[eventId]/messages/retry-failed/route";

const context = { params: Promise.resolve({ eventId: "event-1" }) };
const previewFingerprint = "a".repeat(64);
const clientRequestId = "0a01f2cb-efaa-48da-9059-9d7b4510488a";
const url = "https://events.imsda.test/api/events/event-1/messages/retry-failed";

function post(body: unknown = { clientRequestId, scope: { type: "EVENT" }, previewFingerprint }) {
  return new Request(url, {
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
  mocks.getMessagingWorkspace.mockResolvedValue({ counts: { FAILED: 0 } });
  mocks.previewFailedMessagesRetry.mockResolvedValue({ fingerprint: previewFingerprint, queueCount: 2 });
  mocks.retryFailedMessages.mockResolvedValue({ queuedCount: 2, skippedCount: 1, remainingCount: 0, replayed: false });
});

describe("POST /messages/retry-failed", () => {
  it("requires MANAGE_COMMUNICATIONS and returns 403 without it, queueing nothing", async () => {
    mocks.requirePermission.mockRejectedValue(new mocks.AccessDeniedError("You do not have access to this event."));
    const response = await POST(post(), context);
    expect(response.status).toBe(403);
    expect(mocks.requirePermission).toHaveBeenCalledWith(expect.anything(), "event-1", "MANAGE_COMMUNICATIONS", mocks.findActiveMembership);
    expect(mocks.retryFailedMessages).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin post before reading the session", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(Response.json({ error: "CROSS_ORIGIN" }, { status: 403 }));
    const response = await POST(post(), context);
    expect(response.status).toBe(403);
    expect(mocks.requirePermission).not.toHaveBeenCalled();
  });

  it("is a 404 when the batch belongs to another event", async () => {
    mocks.retryFailedMessages.mockRejectedValue(new mocks.MessagingError("MESSAGE_NOT_FOUND", "That send batch is no longer available."));
    const response = await POST(post({ clientRequestId, scope: { type: "BATCH", batchId: "other-event-batch" }, previewFingerprint }), context);
    expect(response.status).toBe(404);
  });

  it("queues the confirmed set with the session user and returns the refreshed workspace", async () => {
    const response = await POST(post(), context);
    expect(response.status).toBe(201);
    expect(mocks.retryFailedMessages).toHaveBeenCalledWith(
      "event-1",
      { clientRequestId, scope: { type: "EVENT" }, previewFingerprint },
      "staff-1",
    );
    expect(await response.json()).toMatchObject({ operation: { queuedCount: 2 }, messaging: { counts: { FAILED: 0 } } });
  });

  it("answers an idempotent re-post with the recorded result and a 200", async () => {
    mocks.retryFailedMessages.mockResolvedValue({ queuedCount: 2, skippedCount: 1, remainingCount: 0, replayed: true });
    const response = await POST(post(), context);
    expect(response.status).toBe(200);
    expect((await response.json()).operation.replayed).toBe(true);
  });

  it("returns 409 for a changed preview and a reused request id", async () => {
    mocks.retryFailedMessages.mockRejectedValueOnce(new mocks.MessagingError("PREVIEW_CHANGED", "Preview again."));
    expect((await POST(post(), context)).status).toBe(409);
    mocks.retryFailedMessages.mockRejectedValueOnce(new mocks.MessagingError("IDEMPOTENCY_KEY_REUSED", "Reused."));
    expect((await POST(post(), context)).status).toBe(409);
  });

  it("rejects an unknown field, a bad fingerprint and a missing request id with 400", async () => {
    for (const body of [
      { clientRequestId, scope: { type: "EVENT" }, previewFingerprint, messageIds: ["m1"] },
      { clientRequestId, scope: { type: "EVENT" }, previewFingerprint: "short" },
      { scope: { type: "EVENT" }, previewFingerprint },
      { clientRequestId, scope: { type: "BATCH" }, previewFingerprint },
    ]) {
      expect((await POST(post(body), context)).status).toBe(400);
    }
    expect(mocks.retryFailedMessages).not.toHaveBeenCalled();
  });
});

describe("GET /messages/retry-failed", () => {
  it("previews the whole event by default and one batch with ?batchId=", async () => {
    await GET(new Request(url), context);
    expect(mocks.previewFailedMessagesRetry).toHaveBeenLastCalledWith("event-1", { type: "EVENT" });
    await GET(new Request(`${url}?batchId=batch-1`), context);
    expect(mocks.previewFailedMessagesRetry).toHaveBeenLastCalledWith("event-1", { type: "BATCH", batchId: "batch-1" });
  });

  it("returns 403 without permission and never previews", async () => {
    mocks.requirePermission.mockRejectedValue(new mocks.AccessDeniedError("No."));
    expect((await GET(new Request(url), context)).status).toBe(403);
    expect(mocks.previewFailedMessagesRetry).not.toHaveBeenCalled();
  });
});

describe("GET /messages (delivery log refresh)", () => {
  it("is behind MANAGE_COMMUNICATIONS and not cached", async () => {
    const ok = await getMessages(new Request("https://events.imsda.test/api/events/event-1/messages"), context);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Cache-Control")).toBe("no-store");
    mocks.requirePermission.mockRejectedValue(new mocks.AccessDeniedError("No."));
    expect((await getMessages(new Request("https://events.imsda.test/api/events/event-1/messages"), context)).status).toBe(403);
  });
});
