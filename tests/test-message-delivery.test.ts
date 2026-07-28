import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MESSAGE_TEMPLATES } from "@/modules/communications/templates";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  processExternalEmailQueue: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: mocks.getPrisma,
}));
vi.mock("@/integrations/email/resend", () => ({
  getResendEmailAvailability: () => ({
    deliveryConfigured: true,
    webhookConfigured: true,
  }),
}));
vi.mock("@/modules/communications/email-delivery", () => ({
  ExternalEmailDeliveryError: class ExternalEmailDeliveryError extends Error {},
  processExternalEmailQueue: mocks.processExternalEmailQueue,
}));

import { sendTestMessage } from "@/modules/communications/messaging-repository";

const event = {
  id: "event-1",
  name: "Women’s Retreat",
  slug: "womens-retreat-2026",
  startsAt: new Date("2026-10-09T21:00:00.000Z"),
  endsAt: new Date("2026-10-11T17:00:00.000Z"),
  timezone: "America/Chicago",
  location: "Camp Heritage",
  supportContact: "help@example.test",
};

function settingsWith(overrides: Record<string, unknown> = {}) {
  return {
    deliveryMode: "EXTERNAL_EMAIL" as const,
    senderName: "IMSDA Events",
    senderEmail: "registration@imsda.org",
    replyToEmail: "help@imsda.org",
    internalNotificationEmails: [],
    ...overrides,
  };
}

function baseTransaction(settings = settingsWith()) {
  return {
    eventMessageSettings: {
      upsert: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(settings),
      findUniqueOrThrow: vi.fn().mockResolvedValue(settings),
    },
    eventMessageTemplate: {
      upsert: vi.fn().mockResolvedValue({
        id: "template-existing",
        versions: [{ id: "version-existing" }],
      }),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue({
        id: "template-shirt",
        key: "SHIRT_SIZE_REQUEST",
        isEnabled: true,
        versions: [{
          id: "version-shirt-1",
          versionNumber: 1,
          subjectTemplate: DEFAULT_MESSAGE_TEMPLATES.SHIRT_SIZE_REQUEST.subject,
          bodyTemplate: DEFAULT_MESSAGE_TEMPLATES.SHIRT_SIZE_REQUEST.body,
        }],
      }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    messageTemplateVersion: { create: vi.fn() },
    event: {
      findUnique: vi.fn().mockResolvedValue(event),
    },
    registration: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(null),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    messageOutbox: {
      create: vi.fn().mockResolvedValue({
        id: "message-test-1",
        correlationId: "corr-1",
      }),
      update: vi.fn().mockResolvedValue({}),
      upsert: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue({
        id: "message-test-1",
        status: "PENDING",
      }),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    messageDeliveryAttempt: { create: vi.fn().mockResolvedValue({}) },
  };
}

function prismaFor(tx: ReturnType<typeof baseTransaction>) {
  return {
    ...tx,
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("test message delivery", () => {
  it("delivers through the event's own sender when real delivery is asked for", async () => {
    const tx = baseTransaction();
    mocks.getPrisma.mockReturnValue(prismaFor(tx));

    await sendTestMessage("event-1", "template-shirt", {
      recipientEmail: "caleb@imsda.org",
      recipientName: "Caleb",
      realDelivery: true,
    }, "user-1");

    // Delivered by id through the shared loop, so a failed test lands in the
    // delivery log the same way a failed registrant message does.
    expect(mocks.processExternalEmailQueue).toHaveBeenCalledWith("event-1", {
      messageIds: ["message-test-1"],
    });

    const created = tx.messageOutbox.create.mock.calls[0]?.[0].data;
    expect(created).toMatchObject({
      recipientKind: "TEST",
      recipientEmail: "caleb@imsda.org",
      // The event's identity, not the platform account sender — that is the
      // part a local capture cannot check.
      senderEmailSnapshot: "registration@imsda.org",
      replyToEmailSnapshot: "help@imsda.org",
      metadata: { trigger: "REAL_TEST", realDelivery: true },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "MESSAGE_TEST_SENT" }),
    }));
  });

  it("still captures locally, contacting no provider, when real delivery is not asked for", async () => {
    const tx = baseTransaction(settingsWith({ deliveryMode: "LOCAL_CAPTURE" }));
    mocks.getPrisma.mockReturnValue(prismaFor(tx));

    await sendTestMessage("event-1", "template-shirt", {
      recipientEmail: "message.preview@example.test",
      recipientName: "Local Test Recipient",
      realDelivery: false,
    }, "user-1");

    expect(mocks.processExternalEmailQueue).not.toHaveBeenCalled();
    expect(tx.messageOutbox.create.mock.calls[0]?.[0].data).toMatchObject({
      metadata: { trigger: "LOCAL_TEST", realDelivery: false },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "MESSAGE_TEST_CREATED" }),
    }));
  });

  it("refuses a real test while the event is still capturing locally", async () => {
    const tx = baseTransaction(settingsWith({ deliveryMode: "LOCAL_CAPTURE" }));
    mocks.getPrisma.mockReturnValue(prismaFor(tx));

    await expect(sendTestMessage("event-1", "template-shirt", {
      recipientEmail: "caleb@imsda.org",
      recipientName: "Caleb",
      realDelivery: true,
    }, "user-1")).rejects.toMatchObject({ code: "DELIVERY_DISABLED" });

    // Nothing is written, so a refused test leaves no half-real row behind.
    expect(tx.messageOutbox.create).not.toHaveBeenCalled();
    expect(mocks.processExternalEmailQueue).not.toHaveBeenCalled();
  });

  it("refuses a real test when the event has no sender address", async () => {
    const tx = baseTransaction(settingsWith({ senderEmail: null }));
    mocks.getPrisma.mockReturnValue(prismaFor(tx));

    await expect(sendTestMessage("event-1", "template-shirt", {
      recipientEmail: "caleb@imsda.org",
      recipientName: "Caleb",
      realDelivery: true,
    }, "user-1")).rejects.toMatchObject({ code: "EXTERNAL_EMAIL_NOT_CONFIGURED" });

    expect(tx.messageOutbox.create).not.toHaveBeenCalled();
  });
});
