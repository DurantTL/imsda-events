import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MESSAGE_TEMPLATES,
} from "@/modules/communications/templates";

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
    deliveryConfigured: false,
    webhookConfigured: false,
  }),
}));
vi.mock("@/modules/communications/email-delivery", () => ({
  ExternalEmailDeliveryError: class ExternalEmailDeliveryError extends Error {},
  processExternalEmailQueue: mocks.processExternalEmailQueue,
}));

import {
  MessagingError,
  enqueueBalanceReminderBatch,
  getBalanceReminderPreview,
  resendRegistrationConfirmation,
} from "@/modules/communications/messaging-repository";

const event = {
  id: "event-1",
  name: "Women’s Retreat",
  startsAt: new Date("2026-10-09T21:00:00.000Z"),
  endsAt: new Date("2026-10-11T17:00:00.000Z"),
  timezone: "America/Chicago",
  location: "Camp Heritage",
  supportContact: "help@example.test",
};

const settings = {
  deliveryMode: "EXTERNAL_EMAIL" as const,
  senderName: "IMSDA Events",
  senderEmail: "registration@example.test",
  replyToEmail: "help@example.test",
  internalNotificationEmails: [],
};

function money(value: string) {
  return { toString: () => value };
}

function baseTransaction() {
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
      findUnique: vi.fn().mockResolvedValue({
        id: "template-balance",
        key: "BALANCE_REMINDER",
        isEnabled: true,
        versions: [{
          id: "version-balance-1",
          versionNumber: 1,
          subjectTemplate: DEFAULT_MESSAGE_TEMPLATES.BALANCE_REMINDER.subject,
          bodyTemplate: DEFAULT_MESSAGE_TEMPLATES.BALANCE_REMINDER.body,
        }],
      }),
    },
    messageTemplateVersion: {
      create: vi.fn(),
    },
    event: {
      findUnique: vi.fn().mockResolvedValue(event),
    },
    registration: {
      findMany: vi.fn().mockResolvedValue([{
        id: "registration-1",
        confirmationCode: "REG-ONE",
        status: "CONFIRMED",
        totalAmount: money("200.00"),
        contactSnapshot: {
          firstName: "Avery",
          lastName: "Johnson",
          email: "AVERY@EXAMPLE.TEST",
        },
        accountHolderPerson: {
          firstName: "Canonical",
          lastName: "Person",
          normalizedEmail: "canonical@example.test",
        },
        payments: [{
          amount: money("100.00"),
          refunds: [{ amount: money("25.00") }],
        }],
      }]),
    },
    auditLog: {
      findFirst: vi.fn().mockResolvedValue(null),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    messageOutbox: {
      upsert: vi.fn().mockResolvedValue({
        id: "message-balance-1",
        status: "PENDING",
      }),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
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

describe("balance-reminder repository", () => {
  it("snapshots the reviewed recipient and server-calculated refunded balance without sending", async () => {
    const tx = baseTransaction();
    mocks.getPrisma.mockReturnValue(prismaFor(tx));
    const preview = await getBalanceReminderPreview("event-1");

    const result = await enqueueBalanceReminderBatch("event-1", {
      previewFingerprint: preview.fingerprint,
      batchId: "7d27bacc-90c3-4e74-884e-8aa36c673492",
    }, "user-1");

    expect(result).toMatchObject({
      includedCount: 1,
      totalBalanceCents: 12_500,
      queuedCount: 1,
      capturedCount: 0,
      suppressedCount: 0,
      replayed: false,
    });
    expect(tx.messageOutbox.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        idempotencyKey: "balance-reminder:event-1:7d27bacc-90c3-4e74-884e-8aa36c673492:registration-1",
      },
      create: expect.objectContaining({
        recipientEmail: "avery@example.test",
        subjectSnapshot: "Payment reminder: Women’s Retreat — $125.00 due",
        status: "PENDING",
        metadata: expect.objectContaining({
          balanceCents: 12_500,
          previewFingerprint: preview.fingerprint,
        }),
      }),
    }));
    expect(mocks.processExternalEmailQueue).not.toHaveBeenCalled();
  });

  it("replays an audited batch before recomputing and rejects reuse with another fingerprint", async () => {
    const tx = baseTransaction();
    tx.auditLog.findFirst.mockResolvedValue({
      metadata: {
        previewFingerprint: "a".repeat(64),
        includedCount: 1,
        totalBalanceCents: 12_500,
        deliveryMode: "EXTERNAL_EMAIL",
        initialQueuedCount: 1,
        initialSuppressedCount: 0,
      },
    });
    tx.messageOutbox.findMany.mockResolvedValue([{
      id: "message-existing",
      status: "SENT",
    }]);
    mocks.getPrisma.mockReturnValue(prismaFor(tx));

    await expect(enqueueBalanceReminderBatch("event-1", {
      previewFingerprint: "a".repeat(64),
      batchId: "e19d35b0-fb62-44e0-a1e2-f11202ee15a0",
    }, "user-1")).resolves.toMatchObject({
      messageIds: ["message-existing"],
      queuedCount: 1,
      replayed: true,
    });
    expect(tx.registration.findMany).not.toHaveBeenCalled();

    await expect(enqueueBalanceReminderBatch("event-1", {
      previewFingerprint: "b".repeat(64),
      batchId: "e19d35b0-fb62-44e0-a1e2-f11202ee15a0",
    }, "user-1")).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });
  });
});

type ConfirmationMessage = {
  id: string;
  eventId: string;
  registrationId: string;
  templateVersionId: string;
  templateKey: "REGISTRATION_CONFIRMATION_UNPAID";
  recipientKind: "REGISTRANT";
  recipientEmail: string;
  recipientName: string;
  senderNameSnapshot: string;
  senderEmailSnapshot: string;
  replyToEmailSnapshot: string;
  subjectSnapshot: string;
  bodyTextSnapshot: string;
  metadata: Record<string, unknown>;
  idempotencyKey: string;
  correlationId: string;
  retryOfMessageId: null;
  status: "SENT";
  registration: { confirmationCode: string };
};

function confirmationFixture() {
  const source: ConfirmationMessage = {
    id: "message-source",
    eventId: "event-1",
    registrationId: "registration-1",
    templateVersionId: "version-original",
    templateKey: "REGISTRATION_CONFIRMATION_UNPAID",
    recipientKind: "REGISTRANT",
    recipientEmail: "original@example.test",
    recipientName: "Original Recipient",
    senderNameSnapshot: "Original Sender",
    senderEmailSnapshot: "sender@example.test",
    replyToEmailSnapshot: "reply@example.test",
    subjectSnapshot: "Original immutable subject",
    bodyTextSnapshot: "Original immutable body",
    metadata: {},
    idempotencyKey: "source-key",
    correlationId: "source-correlation",
    retryOfMessageId: null,
    status: "SENT",
    registration: { confirmationCode: "REG-ONE" },
  };
  const saved = new Map<string, {
    id: string;
    status: "PENDING";
    recipientEmail: string;
    metadata: Record<string, unknown>;
  }>();
  const tx = baseTransaction();
  tx.messageOutbox.findFirst = vi.fn(async (args: {
      where: { id?: string; retryOfMessageId?: string };
    }) => {
      if (args.where.id === source.id) return source;
      if (args.where.retryOfMessageId) {
        return [...saved.values()].find((message) => message.status === "PENDING")
          ? { id: "active-copy" }
          : null;
      }
      return null;
    });
  tx.messageOutbox.findUnique = vi.fn(async (args: { where: { idempotencyKey: string } }) => (
      saved.get(args.where.idempotencyKey) ?? null
    ));
  tx.messageOutbox.create = vi.fn(async (args: {
      data: {
        idempotencyKey: string;
        recipientEmail: string;
        metadata: Record<string, unknown>;
      };
    }) => {
      const created = {
        id: "message-copy",
        status: "PENDING" as const,
        recipientEmail: args.data.recipientEmail,
        metadata: args.data.metadata,
      };
      saved.set(args.data.idempotencyKey, created);
      return created;
    });
  return { tx, source, saved };
}

describe("confirmation-resend repository", () => {
  it("copies immutable content to a corrected one-time destination and safely replays the same request", async () => {
    const { tx } = confirmationFixture();
    mocks.getPrisma.mockReturnValue(prismaFor(tx));
    const input = {
      clientRequestId: "57cf9714-ad77-4546-b225-4f8dfc863077",
      correctedRecipientEmail: "corrected@example.test",
    };

    const first = await resendRegistrationConfirmation(
      "event-1",
      "message-source",
      input,
      "user-1",
    );
    const replay = await resendRegistrationConfirmation(
      "event-1",
      "message-source",
      input,
      "user-1",
    );

    expect(first).toMatchObject({
      messageId: "message-copy",
      recipientEmail: "corrected@example.test",
      destinationChanged: true,
      replayed: false,
      status: "PENDING",
    });
    expect(replay).toMatchObject({
      messageId: "message-copy",
      recipientEmail: "corrected@example.test",
      destinationChanged: true,
      replayed: true,
    });
    const create = tx.messageOutbox.create.mock.calls[0]![0].data;
    expect(create).toMatchObject({
      recipientEmail: "corrected@example.test",
      senderNameSnapshot: "Original Sender",
      senderEmailSnapshot: "sender@example.test",
      replyToEmailSnapshot: "reply@example.test",
      subjectSnapshot: "Original immutable subject",
      bodyTextSnapshot: "Original immutable body",
      retryOfMessageId: "message-source",
    });
    expect(tx.messageOutbox.create).toHaveBeenCalledTimes(1);
  });

  it("rejects reuse of a resend request ID with a different destination", async () => {
    const { tx } = confirmationFixture();
    mocks.getPrisma.mockReturnValue(prismaFor(tx));
    const clientRequestId = "57cf9714-ad77-4546-b225-4f8dfc863077";

    await resendRegistrationConfirmation(
      "event-1",
      "message-source",
      {
        clientRequestId,
        correctedRecipientEmail: "corrected@example.test",
      },
      "user-1",
    );

    await expect(resendRegistrationConfirmation(
      "event-1",
      "message-source",
      {
        clientRequestId,
        correctedRecipientEmail: "different@example.test",
      },
      "user-1",
    )).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });
    expect(tx.messageOutbox.create).toHaveBeenCalledTimes(1);
  });

  it("rejects a different request while a resend child is still pending", async () => {
    const { tx, saved } = confirmationFixture();
    saved.set("another-request", {
      id: "already-pending",
      status: "PENDING",
      recipientEmail: "original@example.test",
      metadata: { deliveryMode: "EXTERNAL_EMAIL" },
    });
    mocks.getPrisma.mockReturnValue(prismaFor(tx));

    await expect(resendRegistrationConfirmation(
      "event-1",
      "message-source",
      {
        clientRequestId: "9b201351-dc58-41e2-af9f-9b41e75137d3",
        correctedRecipientEmail: "",
      },
      "user-1",
    )).rejects.toBeInstanceOf(MessagingError);
    await expect(resendRegistrationConfirmation(
      "event-1",
      "message-source",
      {
        clientRequestId: "9b201351-dc58-41e2-af9f-9b41e75137d3",
        correctedRecipientEmail: "",
      },
      "user-1",
    )).rejects.toMatchObject({
      code: "MESSAGE_NOT_RESENDABLE",
    });
  });
});
