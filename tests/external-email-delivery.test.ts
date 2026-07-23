import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { EmailProviderRequestError } from "@/integrations/email/resend";
import {
  EMAIL_DELIVERY_LOCK_TIMEOUT_MS,
  emailRetryDelayMs,
  processExternalEmailQueue,
} from "@/modules/communications/email-delivery";

type MutableMessage = {
  id: string;
  eventId: string;
  registrationId: string | null;
  recipientEmail: string;
  senderNameSnapshot: string;
  senderEmailSnapshot: string | null;
  replyToEmailSnapshot: string | null;
  subjectSnapshot: string;
  bodyTextSnapshot: string;
  status: string;
  attemptCount: number;
  availableAt: Date;
  createdAt: Date;
  lockedAt: Date | null;
  lockToken: string | null;
  [key: string]: unknown;
};

function fakeDeliveryStore(overrides: Partial<MutableMessage> = {}) {
  const message: MutableMessage = {
    id: "message-1",
    eventId: "event-1",
    registrationId: "registration-1",
    recipientEmail: "attendee@example.test",
    senderNameSnapshot: "IMSDA Events",
    senderEmailSnapshot: "registration@imsda.org",
    replyToEmailSnapshot: "help@imsda.org",
    subjectSnapshot: "Registration received",
    bodyTextSnapshot: "Your registration is saved.",
    status: "PENDING",
    attemptCount: 0,
    availableAt: new Date("2026-07-23T12:00:00.000Z"),
    createdAt: new Date("2026-07-23T11:00:00.000Z"),
    lockedAt: null,
    lockToken: null,
    ...overrides,
  };
  const attempts: Array<Record<string, unknown>> = [];

  const messageOutbox = {
    findMany: vi.fn(async () => (
      message.status === "PROCESSING" ? [{
        id: message.id,
        attemptCount: message.attemptCount,
        lockToken: message.lockToken,
        lockedAt: message.lockedAt,
      }] : []
    )),
    findFirst: vi.fn(async () => (
      message.status === "PENDING"
      && message.availableAt <= new Date("2026-07-23T12:00:00.000Z")
        ? {
            id: message.id,
            eventId: message.eventId,
            registrationId: message.registrationId,
            recipientEmail: message.recipientEmail,
            senderNameSnapshot: message.senderNameSnapshot,
            senderEmailSnapshot: message.senderEmailSnapshot,
            replyToEmailSnapshot: message.replyToEmailSnapshot,
            subjectSnapshot: message.subjectSnapshot,
            bodyTextSnapshot: message.bodyTextSnapshot,
            attemptCount: message.attemptCount,
          }
        : null
    )),
    updateMany: vi.fn(async ({ where, data }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      if (where.id !== message.id || (where.status && where.status !== message.status)) {
        return { count: 0 };
      }
      if ("lockToken" in where && where.lockToken !== message.lockToken) {
        return { count: 0 };
      }
      Object.assign(message, data);
      return { count: 1 };
    }),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(message, data);
      return message;
    }),
  };
  const tx = {
    messageOutbox,
    messageDeliveryAttempt: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        attempts.push(data);
        return data;
      }),
    },
    messageProviderEvent: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findFirst: vi.fn(async () => null),
    },
  };
  const prisma = {
    eventMessageSettings: {
      findUnique: vi.fn(async () => ({
        deliveryMode: "EXTERNAL_EMAIL",
        senderEmail: "registration@imsda.org",
      })),
    },
    messageOutbox,
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
  };
  return { prisma, message, attempts };
}

const dependencies = {
  configuration: {
    apiKey: "re_test_only",
    apiUrl: "https://api.resend.test",
  },
  now: () => new Date("2026-07-23T12:00:00.000Z"),
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("external email queue", () => {
  it("sends immutable snapshots and finalizes a SENT attempt", async () => {
    const store = fakeDeliveryStore();
    const sendEmail = vi.fn(async () => ({
      provider: "RESEND" as const,
      providerMessageId: "email-provider-1",
    }));

    const result = await processExternalEmailQueue("event-1", {
      dependencies: {
        ...dependencies,
        prisma: store.prisma as never,
        sendEmail,
      },
    });

    expect(result.sentIds).toEqual(["message-1"]);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        fromEmail: "registration@imsda.org",
        toEmail: "attendee@example.test",
        subject: "Registration received",
        bodyText: "Your registration is saved.",
        idempotencyKey: "outbox:message-1",
      }),
      dependencies.configuration,
    );
    expect(store.message).toMatchObject({
      status: "SENT",
      attemptCount: 1,
      provider: "RESEND",
      providerMessageId: "email-provider-1",
      providerDeliveryStatus: "ACCEPTED",
      lockToken: null,
    });
    expect(store.attempts).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        status: "SENT",
        providerMessageId: "email-provider-1",
      }),
    ]);
  });

  it("inserts a private link only in the in-memory provider payload", async () => {
    const sentinel = "__IMSDA_PRIVATE_MANAGE_LINK__";
    const store = fakeDeliveryStore({
      bodyTextSnapshot: `Manage: ${sentinel}`,
    });
    const prepareBodyText = vi.fn(async () => ({
      bodyText: "Manage: https://events.example.test/manage/private-token",
    }));
    const sendEmail = vi.fn(async () => ({
      provider: "RESEND" as const,
      providerMessageId: "email-provider-private",
    }));

    await processExternalEmailQueue("event-1", {
      dependencies: {
        ...dependencies,
        prisma: store.prisma as never,
        prepareBodyText,
        sendEmail,
      },
    });

    expect(prepareBodyText).toHaveBeenCalledWith({
      messageId: "message-1",
      registrationId: "registration-1",
      bodyText: `Manage: ${sentinel}`,
      now: new Date("2026-07-23T12:00:00.000Z"),
    });
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        bodyText: "Manage: https://events.example.test/manage/private-token",
      }),
      dependencies.configuration,
    );
    expect(store.message.bodyTextSnapshot).toBe(`Manage: ${sentinel}`);
  });

  it("revokes an unused private link after a definitive provider rejection", async () => {
    const store = fakeDeliveryStore({
      bodyTextSnapshot: "Manage: __IMSDA_PRIVATE_MANAGE_LINK__",
    });
    const revokeOnDefinitiveFailure = vi.fn(async () => undefined);
    const sendEmail = vi.fn(async () => {
      throw new EmailProviderRequestError(
        "The sender was rejected.",
        "invalid_from_address",
        false,
        422,
      );
    });

    const result = await processExternalEmailQueue("event-1", {
      dependencies: {
        ...dependencies,
        prisma: store.prisma as never,
        prepareBodyText: vi.fn(async () => ({
          bodyText: "Manage: https://events.example.test/manage/private-token",
          revokeOnDefinitiveFailure,
        })),
        sendEmail,
      },
    });

    expect(result.failedIds).toEqual(["message-1"]);
    expect(revokeOnDefinitiveFailure).toHaveBeenCalledOnce();
  });

  it("records retryable failures and schedules bounded backoff without another send", async () => {
    const store = fakeDeliveryStore();
    const sendEmail = vi.fn(async () => {
      throw new EmailProviderRequestError(
        "Try again later.",
        "rate_limit_exceeded",
        true,
        429,
      );
    });

    const result = await processExternalEmailQueue("event-1", {
      dependencies: {
        ...dependencies,
        prisma: store.prisma as never,
        sendEmail,
      },
    });

    expect(result.rescheduledIds).toEqual(["message-1"]);
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(store.message).toMatchObject({
      status: "PENDING",
      attemptCount: 1,
      lastError: "Try again later.",
      lockToken: null,
    });
    expect(store.message.availableAt.toISOString()).toBe("2026-07-23T12:01:00.000Z");
    expect(store.attempts[0]).toMatchObject({
      status: "FAILED",
      errorCode: "rate_limit_exceeded",
    });
    expect(emailRetryDelayMs(99)).toBe(60 * 60 * 1000);
  });

  it("does not claim or send any message when provider credentials are absent", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const store = fakeDeliveryStore();
    const sendEmail = vi.fn();

    await expect(processExternalEmailQueue("event-1", {
      dependencies: {
        prisma: store.prisma as never,
        now: dependencies.now,
        sendEmail,
      },
    })).rejects.toMatchObject({
      code: "EXTERNAL_EMAIL_NOT_CONFIGURED",
    });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(store.message).toMatchObject({
      status: "PENDING",
      attemptCount: 0,
      lockToken: null,
    });
  });

  it("recovers stale locks as failed attempts before retrying", async () => {
    const now = new Date("2026-07-23T12:00:00.000Z");
    const store = fakeDeliveryStore({
      status: "PROCESSING",
      lockToken: "abandoned-lock",
      lockedAt: new Date(now.getTime() - EMAIL_DELIVERY_LOCK_TIMEOUT_MS - 1),
    });
    const sendEmail = vi.fn();

    const result = await processExternalEmailQueue("event-1", {
      dependencies: {
        ...dependencies,
        prisma: store.prisma as never,
        sendEmail,
      },
    });

    expect(result.recoveredIds).toEqual(["message-1"]);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(store.message).toMatchObject({
      status: "PENDING",
      attemptCount: 1,
      lockToken: null,
    });
    expect(store.attempts[0]).toMatchObject({
      status: "FAILED",
      errorCode: "STALE_DELIVERY_LOCK",
    });
  });
});
