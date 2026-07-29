import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  enqueueAttendeeEmail: vi.fn(),
  isAttendeeEmailConfigured: vi.fn(),
  processAccountEmailQueue: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/attendee-accounts/attendee-email", () => ({
  enqueueAttendeeEmail: dependencies.enqueueAttendeeEmail,
  isAttendeeEmailConfigured: dependencies.isAttendeeEmailConfigured,
}));
vi.mock("@/modules/communications/email-delivery", () => ({
  processAccountEmailQueue: dependencies.processAccountEmailQueue,
}));
vi.mock("@/lib/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

import {
  deliverQueuedAttendeeEmail,
  queueAttendeePasswordResetEmail,
} from "@/modules/attendee-accounts/attendee-email-dispatch";

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.isAttendeeEmailConfigured.mockReturnValue(true);
  dependencies.enqueueAttendeeEmail.mockResolvedValue({ messageId: "message-1" });
  dependencies.processAccountEmailQueue.mockResolvedValue({
    recoveredIds: [],
    sentIds: ["message-1"],
    failedIds: [],
    rescheduledIds: [],
  });
});

describe("attendee email dispatch timing", () => {
  it("queues a reset without contacting the provider in the response path", async () => {
    const queued = await queueAttendeePasswordResetEmail({
      accountId: "acct-1",
      email: "person@example.com",
      displayName: "A Person",
      federatedOnly: false,
    });

    expect(queued).toEqual({ configured: true, messageId: "message-1" });
    expect(dependencies.enqueueAttendeeEmail).toHaveBeenCalledOnce();
    expect(dependencies.processAccountEmailQueue).not.toHaveBeenCalled();
  });

  it("delivers only when the post-response callback runs", async () => {
    await deliverQueuedAttendeeEmail("message-1");

    expect(dependencies.processAccountEmailQueue).toHaveBeenCalledWith({
      messageIds: ["message-1"],
      limit: 1,
    });
  });
});
