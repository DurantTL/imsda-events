import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  messageRetryRequestFingerprint,
  type MessageRetryFingerprintInput,
} from "@/modules/communications/message-retry-domain";

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
  retryMessage,
} from "@/modules/communications/messaging-repository";

const settings = {
  deliveryMode: "EXTERNAL_EMAIL" as const,
  senderName: "IMSDA Events",
  senderEmail: "registration@example.test",
  replyToEmail: "help@example.test",
  internalNotificationEmails: [],
};

function sourceMessage(
  id = "message-source",
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    eventId: "event-1",
    registrationId: "registration-1",
    templateVersionId: "template-version-1",
    templateKey: "REGISTRATION_CONFIRMATION_UNPAID" as const,
    recipientKind: "REGISTRANT" as const,
    recipientEmail: "recipient@example.test",
    recipientName: "Sample Recipient",
    senderNameSnapshot: "IMSDA Events",
    senderEmailSnapshot: "registration@example.test",
    replyToEmailSnapshot: "help@example.test",
    subjectSnapshot: "Immutable retry subject",
    bodyTextSnapshot:
      "Immutable retry body with __IMSDA_PRIVATE_MANAGE_LINK__",
    metadata: {
      trigger: "PUBLIC_REGISTRATION_SUBMITTED",
      privateManageToken: "must-not-be-copied",
    },
    idempotencyKey: `source:${id}`,
    correlationId: `source-correlation:${id}`,
    retryOfMessageId: null,
    status: "FAILED" as const,
    ...overrides,
  };
}

function fingerprintFor(
  source: ReturnType<typeof sourceMessage>,
  deliveryMode = settings.deliveryMode,
) {
  return messageRetryRequestFingerprint({
    eventId: source.eventId,
    sourceMessageId: source.id,
    deliveryMode,
    registrationId: source.registrationId,
    templateVersionId: source.templateVersionId,
    templateKey: source.templateKey,
    recipientKind: source.recipientKind,
    recipientEmail: source.recipientEmail,
    recipientName: source.recipientName,
    senderNameSnapshot: source.senderNameSnapshot,
    senderEmailSnapshot: source.senderEmailSnapshot,
    replyToEmailSnapshot: source.replyToEmailSnapshot,
    subjectSnapshot: source.subjectSnapshot,
    bodyTextSnapshot: source.bodyTextSnapshot,
  } satisfies MessageRetryFingerprintInput);
}

function retryFixture() {
  const sources = new Map([
    ["message-source", sourceMessage()],
    ["message-other", sourceMessage("message-other", {
      recipientEmail: "other@example.test",
    })],
  ]);
  const savedByIdempotency = new Map<string, {
    id: string;
    status: "PENDING" | "SENT";
    retryOfMessageId: string;
    metadata: Record<string, unknown>;
  }>();
  const savedById = new Map<string, {
    id: string;
    status: "PENDING" | "SENT";
    retryOfMessageId: string;
    metadata: Record<string, unknown>;
  }>();
  let activeChild: { id: string } | null = null;
  let createCount = 0;
  let inTransaction = false;
  const tx = {
    eventMessageSettings: {
      upsert: vi.fn().mockResolvedValue({}),
      findUniqueOrThrow: vi.fn().mockResolvedValue(settings),
    },
    eventMessageTemplate: {
      upsert: vi.fn().mockResolvedValue({
        id: "template-existing",
        versions: [{ id: "version-existing" }],
      }),
    },
    messageTemplateVersion: {
      create: vi.fn(),
    },
    messageOutbox: {
      findUnique: vi.fn(async (args: {
        where: { idempotencyKey?: string; id?: string };
      }) => {
        if (args.where.idempotencyKey) {
          return savedByIdempotency.get(args.where.idempotencyKey) ?? null;
        }
        if (args.where.id) return savedById.get(args.where.id) ?? null;
        return null;
      }),
      findFirst: vi.fn(async (args: {
        where: { id?: string; retryOfMessageId?: string };
      }) => {
        if (args.where.id) return sources.get(args.where.id) ?? null;
        if (args.where.retryOfMessageId) return activeChild;
        return null;
      }),
      create: vi.fn(async (args: {
        data: {
          idempotencyKey: string;
          retryOfMessageId: string;
          metadata: Record<string, unknown>;
        };
      }) => {
        createCount += 1;
        const created = {
          id: `message-retry-${createCount}`,
          status: "PENDING" as const,
          retryOfMessageId: args.data.retryOfMessageId,
          metadata: args.data.metadata,
        };
        savedByIdempotency.set(args.data.idempotencyKey, created);
        savedById.set(created.id, created);
        return created;
      }),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (
      operation: (client: typeof tx) => unknown,
    ) => {
      inTransaction = true;
      try {
        return await operation(tx);
      } finally {
        inTransaction = false;
      }
    }),
  };
  return {
    tx,
    prisma,
    sources,
    savedById,
    savedByIdempotency,
    setActiveChild(value: { id: string } | null) {
      activeChild = value;
    },
    isInTransaction() {
      return inTransaction;
    },
  };
}

const clientRequestId = "0a01f2cb-efaa-48da-9059-9d7b4510488a";
const deliveryDependencies = {
  configuration: {} as never,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("generic message retry repository", () => {
  it("replays the same persisted child and never copies private source metadata", async () => {
    const fixture = retryFixture();
    mocks.getPrisma.mockReturnValue(fixture.prisma);
    mocks.processExternalEmailQueue.mockImplementation(async (
      _eventId: string,
      options: { messageIds: string[] },
    ) => {
      expect(fixture.isInTransaction()).toBe(false);
      const saved = fixture.savedById.get(options.messageIds[0]!);
      if (saved) saved.status = "SENT";
      return {
        recoveredIds: [],
        sentIds: options.messageIds,
        failedIds: [],
        rescheduledIds: [],
      };
    });
    const source = fixture.sources.get("message-source")!;
    const input = {
      clientRequestId,
      requestFingerprint: fingerprintFor(source),
    };

    const first = await retryMessage(
      "event-1",
      source.id,
      input,
      "user-1",
      deliveryDependencies,
    );
    const replay = await retryMessage(
      "event-1",
      source.id,
      input,
      "user-1",
      deliveryDependencies,
    );

    expect(first).toMatchObject({
      sourceMessageId: source.id,
      messageId: "message-retry-1",
      status: "SENT",
      replayed: false,
    });
    expect(replay).toMatchObject({
      sourceMessageId: source.id,
      messageId: "message-retry-1",
      status: "SENT",
      replayed: true,
    });
    expect(fixture.tx.messageOutbox.create).toHaveBeenCalledTimes(1);
    expect(fixture.tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(mocks.processExternalEmailQueue).toHaveBeenCalledTimes(1);

    const created = fixture.tx.messageOutbox.create.mock.calls[0]![0].data;
    expect(created).toMatchObject({
      registrationId: source.registrationId,
      recipientEmail: source.recipientEmail,
      senderNameSnapshot: source.senderNameSnapshot,
      subjectSnapshot: source.subjectSnapshot,
      bodyTextSnapshot: source.bodyTextSnapshot,
      idempotencyKey: `message-retry:event-1:${clientRequestId}`,
      correlationId: clientRequestId,
      retryOfMessageId: source.id,
      metadata: {
        trigger: "STAFF_MESSAGE_RETRY",
        sourceMessageId: source.id,
        requestFingerprint: input.requestFingerprint,
        deliveryMode: "EXTERNAL_EMAIL",
        immutableSourceSnapshot: true,
        realDelivery: true,
      },
    });
    expect(JSON.stringify(created.metadata)).not.toContain(
      "must-not-be-copied",
    );
  });

  it("rejects reuse of one event-scoped UUID for another source or payload", async () => {
    const fixture = retryFixture();
    mocks.getPrisma.mockReturnValue(fixture.prisma);
    mocks.processExternalEmailQueue.mockImplementation(async (
      _eventId: string,
      options: { messageIds: string[] },
    ) => {
      const saved = fixture.savedById.get(options.messageIds[0]!);
      if (saved) saved.status = "SENT";
      return {
        recoveredIds: [],
        sentIds: options.messageIds,
        failedIds: [],
        rescheduledIds: [],
      };
    });
    const source = fixture.sources.get("message-source")!;
    await retryMessage(
      "event-1",
      source.id,
      {
        clientRequestId,
        requestFingerprint: fingerprintFor(source),
      },
      "user-1",
      deliveryDependencies,
    );
    const other = fixture.sources.get("message-other")!;
    await expect(retryMessage(
      "event-1",
      other.id,
      {
        clientRequestId,
        requestFingerprint: fingerprintFor(other),
      },
      "user-1",
      deliveryDependencies,
    )).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });
    await expect(retryMessage(
      "event-1",
      source.id,
      {
        clientRequestId,
        requestFingerprint: "f".repeat(64),
      },
      "user-1",
      deliveryDependencies,
    )).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });
    expect(fixture.tx.messageOutbox.create).toHaveBeenCalledTimes(1);
  });

  it("treats a corrected-resend child as the same active-copy boundary", async () => {
    const fixture = retryFixture();
    fixture.setActiveChild({ id: "active-corrected-resend" });
    mocks.getPrisma.mockReturnValue(fixture.prisma);
    const source = fixture.sources.get("message-source")!;

    await expect(retryMessage(
      "event-1",
      source.id,
      {
        clientRequestId,
        requestFingerprint: fingerprintFor(source),
      },
      "user-1",
      deliveryDependencies,
    )).rejects.toMatchObject({
      code: "MESSAGE_NOT_RETRYABLE",
    });
    expect(fixture.tx.messageOutbox.findFirst).toHaveBeenCalledWith({
      where: {
        retryOfMessageId: source.id,
        status: { in: ["PENDING", "PROCESSING"] },
      },
      select: { id: true },
    });
    expect(fixture.tx.messageOutbox.create).not.toHaveBeenCalled();
    expect(mocks.processExternalEmailQueue).not.toHaveBeenCalled();
  });

  it("rejects a stale source fingerprint before creating or processing", async () => {
    const fixture = retryFixture();
    mocks.getPrisma.mockReturnValue(fixture.prisma);
    await expect(retryMessage(
      "event-1",
      "message-source",
      {
        clientRequestId,
        requestFingerprint: "0".repeat(64),
      },
      "user-1",
      deliveryDependencies,
    )).rejects.toMatchObject({
      code: "PREVIEW_CHANGED",
    });
    expect(fixture.tx.messageOutbox.create).not.toHaveBeenCalled();
    expect(mocks.processExternalEmailQueue).not.toHaveBeenCalled();
  });
});
