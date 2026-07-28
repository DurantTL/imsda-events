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
import {
  messageTestInputSchema,
  type MessageTestInput,
} from "@/modules/communications/schemas";

function testInput(overrides: Partial<MessageTestInput> = {}): MessageTestInput {
  return {
    recipientEmail: "caleb@imsda.org",
    recipientName: "Caleb",
    realDelivery: false,
    confirmationCode: "",
    acknowledgeLinkExposure: false,
    ...overrides,
  };
}

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
    // Read when event messaging settings are first created, so a new event
    // inherits the platform sender identity. Null here keeps these cases on the
    // built-in fallback, which is what they were written against.
    platformSettings: { findUnique: vi.fn().mockResolvedValue(null) },
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
    registration: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue({
        id: "registration-1",
        confirmationCode: "WR26-ONE",
        status: "CONFIRMED",
        totalAmount: { toString: () => "200.00" },
        contactSnapshot: {
          firstName: "Avery",
          lastName: "Johnson",
          email: "avery@example.test",
        },
        accountHolderPerson: {
          firstName: "Avery",
          lastName: "Johnson",
          normalizedEmail: "avery@example.test",
        },
        attendees: [{ person: { firstName: "Blake", lastName: "Johnson" } }],
        payments: [{
          amount: { toString: () => "50.00" },
          refunds: [],
        }],
      }),
    },
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

describe("test message input", () => {
  it("requires an explicit acknowledgement before mailing a real private link", () => {
    const withoutAck = messageTestInputSchema.safeParse({
      recipientEmail: "caleb@imsda.org",
      realDelivery: true,
      confirmationCode: "WR26-ONE",
    });
    expect(withoutAck.success).toBe(false);

    expect(messageTestInputSchema.safeParse({
      recipientEmail: "caleb@imsda.org",
      realDelivery: true,
      confirmationCode: "WR26-ONE",
      acknowledgeLinkExposure: true,
    }).success).toBe(true);
  });

  it("does not require the acknowledgement for a captured test, which mails nothing", () => {
    expect(messageTestInputSchema.safeParse({
      recipientEmail: "message.preview@example.test",
      realDelivery: false,
      confirmationCode: "WR26-ONE",
    }).success).toBe(true);
  });
});

describe("test message delivery", () => {
  it("delivers through the event's own sender when real delivery is asked for", async () => {
    const tx = baseTransaction();
    mocks.getPrisma.mockReturnValue(prismaFor(tx));

    await sendTestMessage("event-1", "template-shirt", testInput({ realDelivery: true }), "user-1");

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

    await sendTestMessage("event-1", "template-shirt", testInput({
      recipientEmail: "message.preview@example.test",
      recipientName: "Local Test Recipient",
      realDelivery: false,
    }), "user-1");

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

    await expect(sendTestMessage("event-1", "template-shirt", testInput({ realDelivery: true }), "user-1")).rejects.toMatchObject({ code: "DELIVERY_DISABLED" });

    // Nothing is written, so a refused test leaves no half-real row behind.
    expect(tx.messageOutbox.create).not.toHaveBeenCalled();
    expect(mocks.processExternalEmailQueue).not.toHaveBeenCalled();
  });

  it("renders a named registration's real values and a link delivery can resolve", async () => {
    const tx = baseTransaction();
    mocks.getPrisma.mockReturnValue(prismaFor(tx));

    await sendTestMessage("event-1", "template-shirt", testInput({
      realDelivery: true,
      confirmationCode: "WR26-ONE",
      acknowledgeLinkExposure: true,
    }), "user-1");

    const created = tx.messageOutbox.create.mock.calls[0]?.[0].data;
    // Delivery mints the private link from this id. Without it the sentinel
    // cannot resolve and the send fails outright.
    expect(created.registrationId).toBe("registration-1");
    expect(created.bodyTextSnapshot).toContain("WR26-ONE");
    expect(created.bodyTextSnapshot).toContain("__IMSDA_PRIVATE_MANAGE_LINK__");
    // Sent somewhere other than the registrant's own address — the case worth
    // finding in an audit later.
    expect(created.metadata).toMatchObject({
      confirmationCode: "WR26-ONE",
      destinationChanged: true,
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        summary: expect.stringContaining("WR26-ONE"),
        metadata: expect.objectContaining({ registrationId: "registration-1" }),
      }),
    }));
  });

  it("keeps the placeholder link and no registration when no code is named", async () => {
    const tx = baseTransaction();
    mocks.getPrisma.mockReturnValue(prismaFor(tx));

    await sendTestMessage("event-1", "template-shirt", testInput({ realDelivery: true }), "user-1");

    const created = tx.messageOutbox.create.mock.calls[0]?.[0].data;
    expect(created.registrationId).toBeNull();
    expect(created.bodyTextSnapshot).not.toContain("__IMSDA_PRIVATE_MANAGE_LINK__");
    expect(tx.registration.findFirst).not.toHaveBeenCalled();
  });

  it("refuses a confirmation code that is not in this event", async () => {
    const tx = baseTransaction();
    tx.registration.findFirst.mockResolvedValue(null);
    mocks.getPrisma.mockReturnValue(prismaFor(tx));

    await expect(sendTestMessage("event-1", "template-shirt", testInput({
      realDelivery: true,
      confirmationCode: "NOT-MINE",
      acknowledgeLinkExposure: true,
    }), "user-1")).rejects.toMatchObject({ code: "MESSAGE_NOT_FOUND" });

    expect(tx.messageOutbox.create).not.toHaveBeenCalled();
  });

  it("refuses a real test when the event has no sender address", async () => {
    const tx = baseTransaction(settingsWith({ senderEmail: null }));
    mocks.getPrisma.mockReturnValue(prismaFor(tx));

    await expect(sendTestMessage("event-1", "template-shirt", testInput({ realDelivery: true }), "user-1")).rejects.toMatchObject({ code: "EXTERNAL_EMAIL_NOT_CONFIGURED" });

    expect(tx.messageOutbox.create).not.toHaveBeenCalled();
  });
});
