import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getCurrentSession: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  findActiveMembership: vi.fn(),
  processPendingMessages: vi.fn(),
  retryMessage: vi.fn(),
  getBalanceReminderPreview: vi.fn(),
  enqueueBalanceReminderBatch: vi.fn(),
  resendRegistrationConfirmation: vi.fn(),
  getMessagingWorkspace: vi.fn(),
  messagingApiError: vi.fn(() => Response.json({ error: "FAILED" }, { status: 500 })),
}));

vi.mock("@/modules/access/authorization", () => ({
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
vi.mock("@/modules/communications/api-errors", () => ({
  messagingApiError: mocks.messagingApiError,
}));
vi.mock("@/modules/communications/messaging-repository", () => ({
  processPendingMessages: mocks.processPendingMessages,
  retryMessage: mocks.retryMessage,
  getBalanceReminderPreview: mocks.getBalanceReminderPreview,
  enqueueBalanceReminderBatch: mocks.enqueueBalanceReminderBatch,
  resendRegistrationConfirmation: mocks.resendRegistrationConfirmation,
  getMessagingWorkspace: mocks.getMessagingWorkspace,
}));

import {
  GET as previewBalanceReminders,
  POST as enqueueBalanceReminders,
} from "@/app/api/events/[eventId]/balance-reminders/route";
import { POST as processQueue } from "@/app/api/events/[eventId]/messages/process/route";
import { POST as resendConfirmation } from "@/app/api/events/[eventId]/messages/[messageId]/resend-confirmation/route";
import { POST as retryMessage } from "@/app/api/events/[eventId]/messages/[messageId]/retry/route";

const request = new Request(
  "https://events.imsda.test/api/events/event-1/messages/process",
  {
    method: "POST",
    headers: { origin: "https://events.imsda.test" },
  },
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.getCurrentSession.mockResolvedValue({ user: { id: "user-1" } });
  mocks.requirePermission.mockResolvedValue({ user: { id: "user-1" } });
  mocks.processPendingMessages.mockResolvedValue({ settings: {} });
  mocks.retryMessage.mockResolvedValue({ settings: {} });
  mocks.getBalanceReminderPreview.mockResolvedValue({
    fingerprint: "a".repeat(64),
  });
  mocks.enqueueBalanceReminderBatch.mockResolvedValue({
    batchId: "9d816996-1eda-4758-8f1a-9f89351afad8",
  });
  mocks.resendRegistrationConfirmation.mockResolvedValue({
    messageId: "message-copy",
  });
  mocks.getMessagingWorkspace.mockResolvedValue({ settings: {} });
});

describe("message processing routes", () => {
  it("authorizes the generalized queue processor", async () => {
    const response = await processQueue(request, {
      params: Promise.resolve({ eventId: "event-1" }),
    });
    expect(response.status).toBe(200);
    expect(mocks.requirePermission).toHaveBeenCalledWith(
      { user: { id: "user-1" } },
      "event-1",
      "MANAGE_COMMUNICATIONS",
      mocks.findActiveMembership,
    );
    expect(mocks.processPendingMessages).toHaveBeenCalledWith("event-1", "user-1");
  });

  it("authorizes an audited message retry", async () => {
    const response = await retryMessage(new Request(
      "https://events.imsda.test/api/events/event-1/messages/message-1/retry",
      {
        method: "POST",
        headers: {
          origin: "https://events.imsda.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          clientRequestId: "c9c5758f-731f-44d9-8ff4-ce0ef94f45f4",
          requestFingerprint: "b".repeat(64),
        }),
      },
    ), {
      params: Promise.resolve({
        eventId: "event-1",
        messageId: "message-1",
      }),
    });
    expect(response.status).toBe(201);
    expect(mocks.retryMessage).toHaveBeenCalledWith(
      "event-1",
      "message-1",
      {
        clientRequestId: "c9c5758f-731f-44d9-8ff4-ce0ef94f45f4",
        requestFingerprint: "b".repeat(64),
      },
      "user-1",
    );
    expect(mocks.getMessagingWorkspace).toHaveBeenCalledWith("event-1");
  });

  it("rejects a retry without both the stable client UUID and fingerprint", async () => {
    const response = await retryMessage(new Request(
      "https://events.imsda.test/api/events/event-1/messages/message-1/retry",
      {
        method: "POST",
        headers: {
          origin: "https://events.imsda.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          clientRequestId: "c9c5758f-731f-44d9-8ff4-ce0ef94f45f4",
        }),
      },
    ), {
      params: Promise.resolve({
        eventId: "event-1",
        messageId: "message-1",
      }),
    });
    expect(response.status).toBe(500);
    expect(mocks.retryMessage).not.toHaveBeenCalled();
    expect(mocks.messagingApiError).toHaveBeenCalledWith(
      expect.anything(),
      "Retrying the message",
    );
  });

  it("rejects cross-origin processing before authorization", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(
      Response.json({ error: "CROSS_ORIGIN_REQUEST" }, { status: 403 }),
    );
    const response = await processQueue(request, {
      params: Promise.resolve({ eventId: "event-1" }),
    });
    expect(response.status).toBe(403);
    expect(mocks.requirePermission).not.toHaveBeenCalled();
    expect(mocks.processPendingMessages).not.toHaveBeenCalled();
  });

  it("returns a read-only, permission-scoped balance-reminder preview", async () => {
    const response = await previewBalanceReminders(request, {
      params: Promise.resolve({ eventId: "event-1" }),
    });
    expect(response.status).toBe(200);
    expect(mocks.requirePermission).toHaveBeenCalledWith(
      { user: { id: "user-1" } },
      "event-1",
      "MANAGE_COMMUNICATIONS",
      mocks.findActiveMembership,
    );
    expect(mocks.getBalanceReminderPreview).toHaveBeenCalledWith("event-1");
  });

  it("requires the reviewed fingerprint and client batch UUID when enqueueing reminders", async () => {
    const response = await enqueueBalanceReminders(new Request(
      "https://events.imsda.test/api/events/event-1/balance-reminders",
      {
        method: "POST",
        headers: {
          origin: "https://events.imsda.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          previewFingerprint: "a".repeat(64),
          batchId: "9d816996-1eda-4758-8f1a-9f89351afad8",
        }),
      },
    ), {
      params: Promise.resolve({ eventId: "event-1" }),
    });
    expect(response.status).toBe(201);
    expect(mocks.enqueueBalanceReminderBatch).toHaveBeenCalledWith(
      "event-1",
      {
        previewFingerprint: "a".repeat(64),
        batchId: "9d816996-1eda-4758-8f1a-9f89351afad8",
      },
      "user-1",
    );
  });

  it("validates and authorizes an optional corrected confirmation destination", async () => {
    const response = await resendConfirmation(new Request(
      "https://events.imsda.test/api/events/event-1/messages/message-1/resend-confirmation",
      {
        method: "POST",
        headers: {
          origin: "https://events.imsda.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          clientRequestId: "75458a17-b9f2-40e8-b2a4-dad1017bf950",
          correctedRecipientEmail: "Corrected@Example.Test",
        }),
      },
    ), {
      params: Promise.resolve({
        eventId: "event-1",
        messageId: "message-1",
      }),
    });
    expect(response.status).toBe(201);
    expect(mocks.resendRegistrationConfirmation).toHaveBeenCalledWith(
      "event-1",
      "message-1",
      {
        clientRequestId: "75458a17-b9f2-40e8-b2a4-dad1017bf950",
        correctedRecipientEmail: "corrected@example.test",
      },
      "user-1",
    );
  });
});
