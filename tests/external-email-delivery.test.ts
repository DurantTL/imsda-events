import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const lodgingStale = vi.hoisted(() => vi.fn());
vi.mock("@/modules/lodging/message-currency", () => ({ lodgingMessageStaleReason: lodgingStale }));

import { renderEmailBodyHtml } from "@/modules/communications/email-html";
import { MessageFileDeliveryError } from "@/modules/communications/message-file-rules";
import { resetServerEnvCache } from "@/lib/env";
import { EmailProviderRequestError } from "@/integrations/email/resend";
import {
  EMAIL_DELIVERY_LOCK_TIMEOUT_MS,
  emailRetryDelayMs,
  normalizeEmailDeliveryError,
  PROVIDER_QUOTA_ERROR_CODE,
  PROVIDER_QUOTA_MESSAGE,
  PROVIDER_RATE_LIMITED_ERROR_CODE,
  PROVIDER_RATE_LIMITED_MESSAGE,
  processAccountEmailQueue,
  processExternalEmailQueue,
} from "@/modules/communications/email-delivery";

type MutableMessage = {
  id: string;
  eventId: string | null;
  accountUserId: string | null;
  templateKey: string;
  registrationId: string | null;
  recipientEmail: string;
  senderNameSnapshot: string;
  senderEmailSnapshot: string | null;
  replyToEmailSnapshot: string | null;
  subjectSnapshot: string;
  bodyTextSnapshot: string;
  bodyHtmlSnapshot: string | null;
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
    accountUserId: null,
    templateKey: "REGISTRATION_CONFIRMATION_PAID",
    registrationId: "registration-1",
    recipientEmail: "attendee@example.test",
    senderNameSnapshot: "IMSDA Events",
    senderEmailSnapshot: "registration@imsda.org",
    replyToEmailSnapshot: "help@imsda.org",
    subjectSnapshot: "Registration received",
    bodyTextSnapshot: "Your registration is saved.",
    bodyHtmlSnapshot: null,
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
            accountUserId: message.accountUserId,
            templateKey: message.templateKey,
            registrationId: message.registrationId,
            recipientEmail: message.recipientEmail,
            senderNameSnapshot: message.senderNameSnapshot,
            senderEmailSnapshot: message.senderEmailSnapshot,
            replyToEmailSnapshot: message.replyToEmailSnapshot,
            subjectSnapshot: message.subjectSnapshot,
            bodyTextSnapshot: message.bodyTextSnapshot,
            bodyHtmlSnapshot: message.bodyHtmlSnapshot,
            attachment: message.attachment ?? null,
            files: message.files ?? [],
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
      findFirst: vi.fn(async ({ where }: { where: { errorCode?: string } }) => {
        const rows = attempts
          .filter((attempt) => attempt.errorCode === where.errorCode && attempt.completedAt instanceof Date)
          .sort((a, b) => (a.completedAt as Date).getTime() - (b.completedAt as Date).getTime());
        return rows[0] ? { completedAt: rows[0].completedAt } : null;
      }),
      aggregate: vi.fn(async () => ({
        _max: { attemptNumber: attempts.length > 0 ? Math.max(...attempts.map((attempt) => Number(attempt.attemptNumber))) : null },
      })),
    },
    messageProviderEvent: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findFirst: vi.fn(async () => null),
    },
    clubFormLink: { updateMany: vi.fn(async () => ({ count: 1 })) },
    healthRecordLink: { updateMany: vi.fn(async () => ({ count: 0 })) },
  };
  const prisma = {
    eventMessageSettings: {
      findUnique: vi.fn(async () => ({
        deliveryMode: "EXTERNAL_EMAIL",
        senderEmail: "registration@imsda.org",
      })),
    },
    messageOutbox,
    invoiceDeliveryRecipient: { findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
  };
  return { prisma, message, attempts, tx };
}

/** The `where` of every claim query the run issued. */
function claimQueries(store: { prisma: { messageOutbox: { findFirst: { mock: { calls: unknown[][] } } } } }) {
  return store.prisma.messageOutbox.findFirst.mock.calls.map(
    (call) => call[0] as { where: Record<string, unknown> },
  );
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

  /**
   * Both bodies were rendered together at enqueue, where trusted and untrusted
   * token spans were still distinguishable. Delivery wraps the stored fragment
   * rather than re-parsing the finished text, which by then cannot tell a
   * template's Markdown from a registrant's.
   */
  it("wraps the stored HTML snapshot and sends it beside the text", async () => {
    const store = fakeDeliveryStore({
      bodyTextSnapshot: "# Registration confirmed\n\nHello **Avery**.",
      bodyHtmlSnapshot: "<h1>Registration confirmed</h1>\n<p>Hello <strong>Avery</strong>.</p>",
    });
    let payload: { bodyText: string; bodyHtml?: string | null } | null = null;
    const sendEmail = vi.fn(async (input: { bodyText: string; bodyHtml?: string | null }) => {
      payload = { bodyText: input.bodyText, bodyHtml: input.bodyHtml };
      return { provider: "RESEND" as const, providerMessageId: "email-provider-html" };
    });

    await processExternalEmailQueue("event-1", {
      dependencies: { ...dependencies, prisma: store.prisma as never, sendEmail: sendEmail as never },
    });

    expect(payload).not.toBeNull();
    expect(payload!.bodyText).toBe("# Registration confirmed\n\nHello **Avery**.");
    expect(payload!.bodyHtml).toContain("<!DOCTYPE html>");
    expect(payload!.bodyHtml).toContain("<h1>Registration confirmed</h1>");
    expect(payload!.bodyHtml).toContain("<strong>Avery</strong>");
    // Nothing new is written back: the row keeps only what it was captured with.
    expect(store.message.bodyTextSnapshot).toBe("# Registration confirmed\n\nHello **Avery**.");
  });

  /** An invoice PDF (#168) rides along as a stored attachment, byte for byte, and only when its hash still matches. */
  it("hands the provider the stored attachment, and refuses one whose hash no longer matches", async () => {
    const bytes = Buffer.from("%PDF-1.7 synthetic invoice bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const good = fakeDeliveryStore({ templateKey: "INVOICE_DELIVERY", registrationId: null, attachment: { filename: "Invoice-SC27-0001.pdf", contentType: "application/pdf", sha256, content: bytes } });
    let provided: Array<{ filename: string; contentType: string; content: Uint8Array }> | undefined;
    const sendEmail = vi.fn(async (input: { attachments?: Array<{ filename: string; contentType: string; content: Uint8Array }> }) => {
      provided = input.attachments;
      return { provider: "RESEND" as const, providerMessageId: "email-provider-attachment" };
    });
    const result = await processExternalEmailQueue("event-1", { dependencies: { ...dependencies, prisma: good.prisma as never, sendEmail: sendEmail as never } });
    expect(result.sentIds).toEqual(["message-1"]);
    expect(provided).toHaveLength(1);
    expect(provided![0]).toMatchObject({ filename: "Invoice-SC27-0001.pdf", contentType: "application/pdf" });
    expect(Buffer.from(provided![0]!.content).equals(bytes)).toBe(true);

    const tampered = fakeDeliveryStore({ templateKey: "INVOICE_DELIVERY", registrationId: null, attachment: { filename: "Invoice-SC27-0001.pdf", contentType: "application/pdf", sha256, content: Buffer.from("%PDF-1.7 something else") } });
    const refused = vi.fn();
    const failed = await processExternalEmailQueue("event-1", { dependencies: { ...dependencies, prisma: tampered.prisma as never, sendEmail: refused as never } });
    expect(refused).not.toHaveBeenCalled();
    expect(failed.sentIds).toEqual([]);
    expect(failed.failedIds).toEqual(["message-1"]);
    expect(tampered.message.status).toBe("FAILED");
  });

  it("cancels, audits and never sends an invoice email whose version is replaced before or during delivery (#168)", async () => {
    const bytes = Buffer.from("%PDF-1.7 synthetic");
    const attachment = { filename: "Invoice-SC27-0001.pdf", contentType: "application/pdf", sha256: createHash("sha256").update(bytes).digest("hex"), content: bytes };
    // Replaced while the body was being prepared: the first check passes, the one right before the send does not.
    const mid = fakeDeliveryStore({ templateKey: "INVOICE_DELIVERY", registrationId: null, attachment });
    mid.prisma.invoiceDeliveryRecipient.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "recipient-1" } as never);
    const sendEmail = vi.fn();
    const result = await processExternalEmailQueue("event-1", { dependencies: { ...dependencies, prisma: mid.prisma as never, sendEmail: sendEmail as never } });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(result.sentIds).toEqual([]);
    expect(mid.message.status).toBe("CANCELLED");
    expect(mid.prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "INVOICE_MESSAGE_CANCELLED", entityId: "message-1", metadata: { messageId: "message-1", reason: "Invoice version superseded" } }) });
    // Replaced before it was claimed.
    const early = fakeDeliveryStore({ templateKey: "INVOICE_DELIVERY", registrationId: null, attachment });
    early.prisma.invoiceDeliveryRecipient.findFirst.mockResolvedValue({ id: "recipient-1" } as never);
    await processExternalEmailQueue("event-1", { dependencies: { ...dependencies, prisma: early.prisma as never, sendEmail: sendEmail as never } });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(early.message.status).toBe("CANCELLED");
  });

  it("cancels, audits and never sends a stale lodging notice or offer, and leaves other messages alone (#200)", async () => {
    for (const templateKey of ["LODGING_ASSIGNMENT_NOTICE", "LODGING_WAITLIST_OFFER"]) {
      lodgingStale.mockReset();
      lodgingStale.mockResolvedValue("A later room change made this notice out of date before it was sent.");
      const stale = fakeDeliveryStore({ templateKey });
      const sendEmail = vi.fn();
      const result = await processExternalEmailQueue("event-1", { dependencies: { ...dependencies, prisma: stale.prisma as never, sendEmail: sendEmail as never } });
      expect(sendEmail).not.toHaveBeenCalled();
      expect(result.sentIds).toEqual([]);
      expect(stale.message.status).toBe("CANCELLED");
      expect(stale.message.lastError).toContain("out of date");
      expect(stale.prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "LODGING_MESSAGE_CANCELLED", entityId: "message-1", metadata: { messageId: "message-1", templateKey } }) });
    }
    // A current lodging email is sent; a message of any other kind never even asks.
    lodgingStale.mockReset();
    lodgingStale.mockResolvedValue(null);
    const current = fakeDeliveryStore({ templateKey: "LODGING_ASSIGNMENT_NOTICE" });
    const sent = vi.fn(async () => ({ provider: "RESEND" as const, providerMessageId: "email-provider-lodging" }));
    expect((await processExternalEmailQueue("event-1", { dependencies: { ...dependencies, prisma: current.prisma as never, sendEmail: sent as never } })).sentIds).toEqual(["message-1"]);
    lodgingStale.mockReset();
    const other = fakeDeliveryStore();
    const sentOther = vi.fn(async () => ({ provider: "RESEND" as const, providerMessageId: "email-provider-other" }));
    expect((await processExternalEmailQueue("event-1", { dependencies: { ...dependencies, prisma: other.prisma as never, sendEmail: sentOther as never } })).sentIds).toEqual(["message-1"]);
    expect(lodgingStale).not.toHaveBeenCalled();
  });

  it("counts a failed lodging currency check as an attempt, retries with backoff, and ends as FAILED after the last one", async () => {
    lodgingStale.mockReset();
    lodgingStale.mockRejectedValue(new Error("database unavailable"));
    const store = fakeDeliveryStore({ templateKey: "LODGING_WAITLIST_OFFER" });
    const sendEmail = vi.fn();
    const result = await processExternalEmailQueue("event-1", { dependencies: { ...dependencies, prisma: store.prisma as never, sendEmail: sendEmail as never } });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(result.sentIds).toEqual([]);
    expect(store.message).toMatchObject({ status: "PENDING", lockToken: null, lockedAt: null, attemptCount: 1 });
    expect(store.message.availableAt.getTime()).toBe(dependencies.now().getTime() + emailRetryDelayMs(1));
    expect(store.attempts).toEqual([expect.objectContaining({ attemptNumber: 1, status: "FAILED", errorCode: "LODGING_CURRENCY_CHECK_FAILED", provider: "INTERNAL", providerMetadata: expect.objectContaining({ realDelivery: false }) })]);
    // The last allowed attempt ends as FAILED rather than retrying forever.
    const last = fakeDeliveryStore({ templateKey: "LODGING_WAITLIST_OFFER", attemptCount: 4 });
    await processExternalEmailQueue("event-1", { dependencies: { ...dependencies, prisma: last.prisma as never, sendEmail: sendEmail as never } });
    expect(last.message.status).toBe("FAILED");
  });

  it("sends a message with no attachment exactly as before", async () => {
    const store = fakeDeliveryStore();
    const sendEmail = vi.fn(async (input: { attachments?: unknown }) => {
      expect(input.attachments).toBeUndefined();
      return { provider: "RESEND" as const, providerMessageId: "email-provider-plain" };
    });
    await processExternalEmailQueue("event-1", { dependencies: { ...dependencies, prisma: store.prisma as never, sendEmail: sendEmail as never } });
    expect(sendEmail).toHaveBeenCalledOnce();
  });

  /**
   * Rows queued before HTML bodies existed have no fragment. Re-deriving one
   * from their text would re-parse whatever a registrant typed as Markdown, so
   * they go out as text only.
   */
  it("sends a pre-HTML row as text only rather than re-parsing its body", async () => {
    const store = fakeDeliveryStore({
      bodyTextSnapshot: "Hello [Avery](https://malicious.example).",
      bodyHtmlSnapshot: null,
    });
    let payload: { bodyText: string; bodyHtml?: string | null } | null = null;
    const sendEmail = vi.fn(async (input: { bodyText: string; bodyHtml?: string | null }) => {
      payload = { bodyText: input.bodyText, bodyHtml: input.bodyHtml };
      return { provider: "RESEND" as const, providerMessageId: "email-provider-legacy" };
    });

    await processExternalEmailQueue("event-1", {
      dependencies: { ...dependencies, prisma: store.prisma as never, sendEmail: sendEmail as never },
    });

    expect(payload).not.toBeNull();
    expect(payload!.bodyText).toBe("Hello [Avery](https://malicious.example).");
    expect(payload!.bodyHtml).toBeNull();
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
      accountUserId: null,
      templateKey: "REGISTRATION_CONFIRMATION_PAID",
      bodyText: `Manage: ${sentinel}`,
      bodyHtml: null,
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
        "HTTP_503",
        true,
        503,
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
      errorCode: "HTTP_503",
    });
    expect(emailRetryDelayMs(99)).toBe(60 * 60 * 1000);
  });

  it("records a provider quota as PROVIDER_QUOTA with a staff-readable reason and backs off in hours (#860)", async () => {
    for (const name of ["daily_quota_exceeded", "monthly_quota_exceeded"]) {
      const store = fakeDeliveryStore();
      const sendEmail = vi.fn(async () => {
        throw new EmailProviderRequestError("You have reached your daily email sending quota.", name, true, 429);
      });
      const result = await processExternalEmailQueue("event-1", {
        dependencies: { ...dependencies, prisma: store.prisma as never, sendEmail },
      });
      expect(result.rescheduledIds).toEqual(["message-1"]);
      expect(store.message).toMatchObject({
        status: "PENDING",
        attemptCount: 0,
        lastError: PROVIDER_QUOTA_MESSAGE,
      });
      expect(store.message.lastError).toBe("The email provider's sending limit was reached. The message will be tried again later; staff can also retry it from the delivery log once the limit resets.");
      // Two hours after the attempt, not one minute.
      expect(store.message.availableAt.getTime()).toBe(dependencies.now().getTime() + 2 * 60 * 60 * 1000);
      expect(store.attempts[0]).toMatchObject({ status: "FAILED", errorCode: "PROVIDER_QUOTA" });
    }
  });

  it("treats rate_limit_exceeded as PROVIDER_RATE_LIMITED with the normal minute backoff, and keys the hours backoff off the PROVIDER_QUOTA code alone", async () => {
    const store = fakeDeliveryStore();
    const sendEmail = vi.fn(async () => {
      throw new EmailProviderRequestError("Too many requests.", "rate_limit_exceeded", true, 429);
    });
    const result = await processExternalEmailQueue("event-1", {
      dependencies: { ...dependencies, prisma: store.prisma as never, sendEmail },
    });
    expect(result.rescheduledIds).toEqual(["message-1"]);
    expect(store.message).toMatchObject({ status: "PENDING", attemptCount: 1, lastError: PROVIDER_RATE_LIMITED_MESSAGE });
    expect(store.message.availableAt.getTime()).toBe(dependencies.now().getTime() + 60_000);
    expect(store.attempts[0]).toMatchObject({ status: "FAILED", errorCode: "PROVIDER_RATE_LIMITED" });
    expect(emailRetryDelayMs(1, PROVIDER_RATE_LIMITED_ERROR_CODE)).toBe(60_000);
    // Any adapter that emits PROVIDER_QUOTA (for example SES, #861) gets the hours backoff.
    expect(emailRetryDelayMs(1, "PROVIDER_QUOTA")).toBe(2 * 60 * 60 * 1000);
  });

  it("backs off in hours and never lets a quota use up an attempt or end the message (#860)", async () => {
    expect([1, 2, 3, 4].map((attempt) => emailRetryDelayMs(attempt, PROVIDER_QUOTA_ERROR_CODE) / 3_600_000)).toEqual([2, 4, 8, 16]);
    expect(emailRetryDelayMs(10, PROVIDER_QUOTA_ERROR_CODE)).toBe(24 * 60 * 60 * 1000);
    // Other errors keep the minute-scale backoff.
    expect([1, 2, 3, 4].map((attempt) => emailRetryDelayMs(attempt) / 60_000)).toEqual([1, 2, 4, 8]);
    expect(emailRetryDelayMs(3, "HTTP_503")).toBe(emailRetryDelayMs(3));

    // Even on what would be the last attempt, a quota reschedules instead of failing.
    const last = fakeDeliveryStore({ attemptCount: 4 });
    const sendEmail = vi.fn(async () => {
      throw new EmailProviderRequestError("quota", "daily_quota_exceeded", true, 429);
    });
    const result = await processExternalEmailQueue("event-1", {
      dependencies: { ...dependencies, prisma: last.prisma as never, sendEmail },
    });
    expect(result.failedIds).toEqual([]);
    expect(result.rescheduledIds).toEqual(["message-1"]);
    expect(last.message).toMatchObject({ status: "PENDING", attemptCount: 4, lastError: PROVIDER_QUOTA_MESSAGE });
    expect(last.attempts[0]).toMatchObject({ errorCode: "PROVIDER_QUOTA", status: "FAILED", providerMetadata: expect.objectContaining({ quotaDeferred: true }) });
  });

  it("survives more than five quota rejections without becoming FAILED, then sends once the quota resets", async () => {
    const store = fakeDeliveryStore();
    let exhausted = true;
    const sendEmail = vi.fn(async () => {
      if (exhausted) throw new EmailProviderRequestError("quota", "daily_quota_exceeded", true, 429);
      return { provider: "RESEND" as const, providerMessageId: "email-after-reset" };
    });
    const baseAvailableAt = new Date(store.message.availableAt);
    const delays: number[] = [];
    for (let rejection = 1; rejection <= 7; rejection += 1) {
      store.message.availableAt = baseAvailableAt;
      await processExternalEmailQueue("event-1", { dependencies: { ...dependencies, prisma: store.prisma as never, sendEmail } });
      expect(store.message.status).toBe("PENDING");
      expect(store.message.attemptCount).toBe(0);
      delays.push((store.message.availableAt.getTime() - baseAvailableAt.getTime()) / 3_600_000);
    }
    expect(sendEmail).toHaveBeenCalledTimes(7);
    expect(delays).toEqual([2, 4, 8, 16, 24, 24, 24]);
    expect(store.attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    exhausted = false;
    store.message.availableAt = baseAvailableAt;
    const result = await processExternalEmailQueue("event-1", { dependencies: { ...dependencies, prisma: store.prisma as never, sendEmail } });
    expect(result.sentIds).toEqual(["message-1"]);
    expect(store.message).toMatchObject({ status: "SENT", attemptCount: 1 });
    expect(store.attempts[7]).toMatchObject({ attemptNumber: 8, status: "SENT" });
  });

  it("gives up after 72 hours of quota deferral: FAILED with PROVIDER_QUOTA and the gave-up message, measured from the first deferral (#860)", async () => {
    const now = dependencies.now().getTime();
    const quotaError = async () => {
      throw new EmailProviderRequestError("quota", "daily_quota_exceeded", true, 429);
    };
    // First deferral 71 hours ago: still waiting.
    const waiting = fakeDeliveryStore();
    waiting.attempts.push({ attemptNumber: 1, errorCode: "PROVIDER_QUOTA", completedAt: new Date(now - 71 * 3_600_000) });
    const stillWaiting = await processExternalEmailQueue("event-1", { dependencies: { ...dependencies, prisma: waiting.prisma as never, sendEmail: quotaError } });
    expect(stillWaiting.failedIds).toEqual([]);
    expect(waiting.message).toMatchObject({ status: "PENDING", lastError: PROVIDER_QUOTA_MESSAGE });

    // First deferral 73 hours ago: gives up through the normal final-failure path.
    const expired = fakeDeliveryStore();
    expired.attempts.push({ attemptNumber: 1, errorCode: "PROVIDER_QUOTA", completedAt: new Date(now - 73 * 3_600_000) });
    const result = await processExternalEmailQueue("event-1", { dependencies: { ...dependencies, prisma: expired.prisma as never, sendEmail: quotaError } });
    expect(result.failedIds).toEqual(["message-1"]);
    expect(expired.message).toMatchObject({ status: "FAILED", lastError: "Gave up waiting for the email provider's sending limit", attemptCount: 1 });
    expect(expired.message.failedAt).toEqual(dependencies.now());
    expect(expired.attempts[1]).toMatchObject({ errorCode: "PROVIDER_QUOTA", errorMessage: "Gave up waiting for the email provider's sending limit", attemptNumber: 2, providerMetadata: expect.objectContaining({ quotaGaveUp: true, rescheduled: false }) });
    // Exactly at the limit counts as expired; the run stops after it.
    expect(claimQueries(expired)).toHaveLength(1);
    const boundary = fakeDeliveryStore();
    boundary.attempts.push({ attemptNumber: 1, errorCode: "PROVIDER_QUOTA", completedAt: new Date(now - 72 * 3_600_000) });
    await processExternalEmailQueue("event-1", { dependencies: { ...dependencies, prisma: boundary.prisma as never, sendEmail: quotaError } });
    expect(boundary.message.status).toBe("FAILED");
  });

  it("stops the run at the first quota error so the rest of the queue is not tried", async () => {
    const store = fakeDeliveryStore();
    const sendEmail = vi.fn(async () => {
      throw new EmailProviderRequestError("quota", "daily_quota_exceeded", true, 429);
    });
    await processExternalEmailQueue("event-1", { dependencies: { ...dependencies, prisma: store.prisma as never, sendEmail } });
    // One claim, then the run ended: it did not go back for the next message.
    expect(claimQueries(store)).toHaveLength(1);
    // A rate limit is different: the run carries on to the next message.
    const limited = fakeDeliveryStore();
    const limitedSend = vi.fn(async () => {
      throw new EmailProviderRequestError("slow down", "rate_limit_exceeded", true, 429);
    });
    await processExternalEmailQueue("event-1", { dependencies: { ...dependencies, prisma: limited.prisma as never, sendEmail: limitedSend } });
    expect(claimQueries(limited)).toHaveLength(2);
    expect(limited.message).toMatchObject({ status: "PENDING", attemptCount: 1 });
  });

  it("recognises only a 429 with a quota or rate-limit name as a provider quota", () => {
    expect(normalizeEmailDeliveryError(new EmailProviderRequestError("x", "daily_quota_exceeded", true, 429))).toMatchObject({ code: "PROVIDER_QUOTA", retryable: true });
    expect(normalizeEmailDeliveryError(new EmailProviderRequestError("x", "rate_limit_exceeded", true, 429))).toMatchObject({ code: "PROVIDER_RATE_LIMITED", retryable: true });
    expect(normalizeEmailDeliveryError(new EmailProviderRequestError("x", "HTTP_429", true, 429))).toMatchObject({ code: "HTTP_429", message: "x" });
    expect(normalizeEmailDeliveryError(new EmailProviderRequestError("x", "quota_not_a_429", true, 503))).toMatchObject({ code: "quota_not_a_429" });
    expect(normalizeEmailDeliveryError(new EmailProviderRequestError("x", "invalid_from_address", false, 422))).toMatchObject({ code: "invalid_from_address", retryable: false });
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

  it("leaves account messages alone: they belong to no event", async () => {
    const store = fakeDeliveryStore();
    const sendEmail = vi.fn(async () => ({
      provider: "RESEND" as const,
      providerMessageId: "email-provider-1",
    }));

    await processExternalEmailQueue("event-1", {
      dependencies: { ...dependencies, prisma: store.prisma as never, sendEmail },
    });

    for (const call of claimQueries(store)) {
      expect(call.where).toMatchObject({ eventId: "event-1" });
    }
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

describe("stale claims on the last attempt", () => {
  it("fails the message and withdraws its club form link in the same transaction (#610)", async () => {
    const now = new Date("2026-07-23T12:00:00.000Z");
    const store = fakeDeliveryStore({
      status: "PROCESSING",
      templateKey: "CLUB_FORM_LINK",
      attemptCount: 4,
      lockToken: "abandoned-lock",
      lockedAt: new Date(now.getTime() - EMAIL_DELIVERY_LOCK_TIMEOUT_MS - 1),
    });
    const result = await processExternalEmailQueue("event-1", {
      dependencies: { ...dependencies, prisma: store.prisma as never, sendEmail: vi.fn() },
    });
    expect(result.recoveredIds).toEqual(["message-1"]);
    expect(store.message.status).toBe("FAILED");
    expect(store.tx.clubFormLink.updateMany).toHaveBeenCalledWith({
      where: { messageId: "message-1", status: "OPEN" },
      data: expect.objectContaining({ status: "REVOKED", tokenHash: null }),
    });
  });

  it("keeps the link while attempts remain", async () => {
    const now = new Date("2026-07-23T12:00:00.000Z");
    const store = fakeDeliveryStore({
      status: "PROCESSING",
      templateKey: "CLUB_FORM_LINK",
      attemptCount: 0,
      lockToken: "abandoned-lock",
      lockedAt: new Date(now.getTime() - EMAIL_DELIVERY_LOCK_TIMEOUT_MS - 1),
    });
    await processExternalEmailQueue("event-1", {
      dependencies: { ...dependencies, prisma: store.prisma as never, sendEmail: vi.fn() },
    });
    expect(store.message.status).toBe("PENDING");
    expect(store.tx.clubFormLink.updateMany).not.toHaveBeenCalled();
  });
});

describe("account email queue", () => {
  function configureAccountEmail(senderAddress: string | undefined) {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("RESEND_API_KEY", "re_test_only");
    vi.stubEnv("APP_BASE_URL", "https://events.imsda.test");
    vi.stubEnv("ACCOUNT_EMAIL_SENDER_ADDRESS", senderAddress ?? "");
    resetServerEnvCache();
  }

  function accountStore() {
    return fakeDeliveryStore({
      eventId: null,
      accountUserId: "user-1",
      templateKey: "ACCOUNT_PASSWORD_RESET",
      registrationId: null,
      recipientEmail: "alex@imsda.org",
      senderNameSnapshot: "IMSDA Events",
      senderEmailSnapshot: "no-reply@imsda.org",
      subjectSnapshot: "Reset your IMSDA Events password",
      bodyTextSnapshot: "Choose a new one: {{account_action_link}}",
    });
  }

  afterEach(() => {
    resetServerEnvCache();
  });

  it("claims only the messages that name no event", async () => {
    configureAccountEmail("no-reply@imsda.org");
    const store = accountStore();
    const sendEmail = vi.fn(async () => ({
      provider: "RESEND" as const,
      providerMessageId: "email-provider-account",
    }));
    const prepareBodyText = vi.fn(async () => ({
      bodyText: "Choose a new one: https://events.imsda.test/reset-password?token=raw",
    }));

    const result = await processAccountEmailQueue({
      dependencies: {
        ...dependencies,
        prisma: store.prisma as never,
        prepareBodyText,
        sendEmail,
      },
    });

    expect(result.sentIds).toEqual(["message-1"]);
    for (const call of claimQueries(store)) {
      expect(call.where).toMatchObject({ eventId: null });
    }
    // The account it belongs to has to reach the body preparer, which is what
    // mints the link.
    expect(prepareBodyText).toHaveBeenCalledWith(expect.objectContaining({
      accountUserId: "user-1",
      templateKey: "ACCOUNT_PASSWORD_RESET",
    }));
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        fromEmail: "no-reply@imsda.org",
        toEmail: "alex@imsda.org",
        bodyText: "Choose a new one: https://events.imsda.test/reset-password?token=raw",
      }),
      dependencies.configuration,
    );
  });

  it("refuses to run, rather than send from nowhere, with no sender configured", async () => {
    configureAccountEmail(undefined);
    const store = accountStore();
    const sendEmail = vi.fn();

    await expect(processAccountEmailQueue({
      dependencies: {
        ...dependencies,
        prisma: store.prisma as never,
        sendEmail,
      },
    })).rejects.toMatchObject({ code: "ACCOUNT_EMAIL_NOT_CONFIGURED" });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(store.message).toMatchObject({ status: "PENDING", attemptCount: 0 });
  });
});


/** Staff attachments and embedded images (#824): built from the outbox row's own file references on every attempt. */
describe("attachments and embedded images", () => {
  const FILE_ID = "cm9abc123def456";
  const QR_URL = "https://events.imsda.test/api/public/manage/token-1/attendee-passes/attendee-1/qr?format=png";
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const PDF = Buffer.from("%PDF-1.7 synthetic agenda");
  const QR = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
  const bodyHtml = renderEmailBodyHtml(
    `Welcome.\n\n![Map of the grounds](msgfile:${FILE_ID})\n\n![Check-in QR code for Ann](${QR_URL})\n\n![Remote](https://example.test/remote.png)`,
  );

  function file(id: string, filename: string, contentType: string, bytes: Buffer) {
    return {
      id,
      filename,
      contentType,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      storageKey: `message-files/event-1/${id}`,
    };
  }

  const stored = new Map<string, Buffer>([["agenda", PDF], [FILE_ID, PNG]]);
  const files = [
    { disposition: "ATTACHMENT" as const, file: file("agenda", "Agenda.pdf", "application/pdf", PDF) },
    { disposition: "INLINE" as const, file: file(FILE_ID, "map.png", "image/png", PNG) },
  ];
  const emailParts = (overrides: Record<string, unknown> = {}) => ({
    readFile: async (row: { id: string }) => {
      const bytes = stored.get(row.id);
      if (!bytes) throw new Error("missing");
      return bytes;
    },
    renderQrPng: async () => QR,
    appOrigin: () => "https://events.imsda.test",
    ...overrides,
  });

  type Sent = { bodyHtml?: string | null; attachments?: Array<{ filename: string; contentType: string; content: Uint8Array; contentId?: string }> };

  it("sends the attachment, an inline part for each embedded picture and QR, and rewrites the HTML to cid:", async () => {
    const store = fakeDeliveryStore({ bodyHtmlSnapshot: bodyHtml, files });
    const sent: Sent[] = [];
    const sendEmail = vi.fn(async (input: Sent) => {
      sent.push(input);
      return { provider: "RESEND" as const, providerMessageId: "email-with-files" };
    });
    const result = await processExternalEmailQueue("event-1", {
      dependencies: { ...dependencies, prisma: store.prisma as never, sendEmail: sendEmail as never, emailParts: emailParts() },
    });
    expect(result.sentIds).toEqual(["message-1"]);
    const attachments = sent[0].attachments ?? [];
    expect(attachments.map((part) => [part.filename, part.contentType, Boolean(part.contentId)])).toEqual([
      ["Agenda.pdf", "application/pdf", false],
      ["map.png", "image/png", true],
      ["check-in-qr.png", "image/png", true],
    ]);
    expect(Buffer.from(attachments[0].content).equals(PDF)).toBe(true);
    expect(Buffer.from(attachments[1].content).equals(PNG)).toBe(true);
    expect(Buffer.from(attachments[2].content).equals(QR)).toBe(true);
    const html = sent[0].bodyHtml ?? "";
    expect(html).toContain(`<img src="cid:${attachments[1].contentId}" alt="Map of the grounds"`);
    expect(html).toContain(`<img src="cid:${attachments[2].contentId}" alt="Check-in QR code for Ann"`);
    expect(html).not.toContain("msgfile:");
    expect(html).not.toContain("/attendee-passes/");
    // An image the author linked remotely is left as written.
    expect(html).toContain('<img src="https://example.test/remote.png" alt="Remote"');
    expect(new Set(attachments.map((part) => part.contentId).filter(Boolean)).size).toBe(2);
  });

  it("resends the same files on a retry of a transient failure", async () => {
    const store = fakeDeliveryStore({ bodyHtmlSnapshot: bodyHtml, files });
    const sent: Sent[] = [];
    const sendEmail = vi.fn()
      .mockRejectedValueOnce(new EmailProviderRequestError("busy", "HTTP_503", true, 503))
      .mockImplementationOnce(async (input: Sent) => {
        sent.push(input);
        return { provider: "RESEND" as const, providerMessageId: "email-retried" };
      });
    const deps = { ...dependencies, prisma: store.prisma as never, sendEmail: sendEmail as never, emailParts: emailParts() };
    const first = await processExternalEmailQueue("event-1", { dependencies: deps });
    expect(first.rescheduledIds).toEqual(["message-1"]);
    expect(store.message.status).toBe("PENDING");
    store.message.availableAt = new Date("2026-07-23T11:00:00.000Z");
    const second = await processExternalEmailQueue("event-1", { dependencies: deps });
    expect(second.sentIds).toEqual(["message-1"]);
    expect(sendEmail).toHaveBeenCalledTimes(2);
    const firstCall = sendEmail.mock.calls[0][0] as Sent;
    const secondCall = sent[0];
    expect(secondCall.attachments?.map((part) => [part.filename, part.contentId])).toEqual(
      firstCall.attachments?.map((part) => [part.filename, part.contentId]),
    );
    expect(secondCall.attachments).toHaveLength(3);
    expect(secondCall.bodyHtml).toBe(firstCall.bodyHtml);
  });

  it("falls back to the remote QR URL when the pass cannot be rendered, and still sends the rest", async () => {
    const store = fakeDeliveryStore({ bodyHtmlSnapshot: bodyHtml, files });
    const sent: Sent[] = [];
    await processExternalEmailQueue("event-1", {
      dependencies: {
        ...dependencies,
        prisma: store.prisma as never,
        sendEmail: (async (input: Sent) => { sent.push(input); return { provider: "RESEND" as const, providerMessageId: "email-fallback" }; }) as never,
        emailParts: emailParts({ renderQrPng: async () => { throw new Error("no pass"); } }),
      },
    });
    const html = sent[0].bodyHtml ?? "";
    expect(html).toContain(`<img src="${QR_URL}" alt="Check-in QR code for Ann"`);
    expect(html).toContain(`<img src="cid:${(sent[0].attachments ?? []).find((part) => part.filename === "map.png")?.contentId}" alt="Map of the grounds"`);
    expect(sent[0].attachments?.map((part) => part.filename)).toEqual(["Agenda.pdf", "map.png"]);
  });

  it("fails the message, and sends nothing, when an uploaded picture is missing, changed or unreadable", async () => {
    for (const [label, failure, retryable] of [
      ["missing", new MessageFileDeliveryError("ATTACHMENT_MISSING", false), false],
      ["changed", new MessageFileDeliveryError("ATTACHMENT_CHANGED", false), false],
      ["unreadable", new MessageFileDeliveryError("ATTACHMENT_UNREADABLE", true), true],
    ] as const) {
      const store = fakeDeliveryStore({ bodyHtmlSnapshot: bodyHtml, files });
      const sendEmail = vi.fn();
      const result = await processExternalEmailQueue("event-1", {
        dependencies: {
          ...dependencies,
          prisma: store.prisma as never,
          sendEmail: sendEmail as never,
          emailParts: emailParts({ readFile: async (row: { id: string }) => { if (row.id === FILE_ID) throw failure; return PDF; } }),
        },
      });
      expect(sendEmail, label).not.toHaveBeenCalled();
      expect(retryable ? result.rescheduledIds : result.failedIds, label).toEqual(["message-1"]);
      expect(store.message.status, label).toBe(retryable ? "PENDING" : "FAILED");
      expect(String(store.message.lastError), label).toBe(failure.message);
      expect(String(store.message.lastError), label).not.toContain("/");
    }
  });

  it("fails a picture that the row does not reference, rather than dropping it to its description", async () => {
    const store = fakeDeliveryStore({ bodyHtmlSnapshot: bodyHtml, files: [files[0]] });
    const sendEmail = vi.fn();
    const result = await processExternalEmailQueue("event-1", {
      dependencies: { ...dependencies, prisma: store.prisma as never, sendEmail: sendEmail as never, emailParts: emailParts() },
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(result.failedIds).toEqual(["message-1"]);
  });

  it("reads a file once per run however many messages carry it", async () => {
    const store = fakeDeliveryStore({ bodyHtmlSnapshot: bodyHtml, files });
    const reads: string[] = [];
    const deps = {
      ...dependencies,
      prisma: store.prisma as never,
      sendEmail: (async () => ({ provider: "RESEND" as const, providerMessageId: `email-${reads.length}` })) as never,
      emailParts: emailParts({ readFile: async (row: { id: string }) => { reads.push(row.id); return stored.get(row.id) ?? PDF; } }),
    };
    await processExternalEmailQueue("event-1", { dependencies: deps });
    expect(reads.sort()).toEqual(["agenda", FILE_ID]);
  });

  it("does not embed a pass image whose address is not this app's own", async () => {
    const store = fakeDeliveryStore({ bodyHtmlSnapshot: bodyHtml, files });
    const renderQrPng = vi.fn(async () => QR);
    const sent: Sent[] = [];
    await processExternalEmailQueue("event-1", {
      dependencies: {
        ...dependencies,
        prisma: store.prisma as never,
        sendEmail: (async (input: Sent) => { sent.push(input); return { provider: "RESEND" as const, providerMessageId: "email-other-origin" }; }) as never,
        emailParts: emailParts({ renderQrPng, appOrigin: () => "https://elsewhere.test" }),
      },
    });
    expect(renderQrPng).not.toHaveBeenCalled();
    expect(sent[0].bodyHtml).toContain(`src="${QR_URL}"`);
  });

  it("does not send at all when an attachment is gone or has changed", async () => {
    const missing = fakeDeliveryStore({ bodyHtmlSnapshot: bodyHtml, files });
    const sendEmail = vi.fn();
    const gone = await processExternalEmailQueue("event-1", {
      dependencies: {
        ...dependencies,
        prisma: missing.prisma as never,
        sendEmail: sendEmail as never,
        emailParts: emailParts({ readFile: async () => { throw new Error("A stored message file no longer matches its recorded hash."); } }),
      },
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(gone.failedIds).toEqual(["message-1"]);
    expect(missing.message.status).toBe("FAILED");
  });

  it("refuses a set of attachments over the per-message limits", async () => {
    const big = Array.from({ length: 3 }, (_, index) => ({
      disposition: "ATTACHMENT" as const,
      file: { ...file(`big-${index}`, `Big ${index}.pdf`, "application/pdf", PDF), sizeBytes: 9 * 1024 * 1024 },
    }));
    const store = fakeDeliveryStore({ bodyHtmlSnapshot: null, files: big });
    const sendEmail = vi.fn();
    const result = await processExternalEmailQueue("event-1", {
      dependencies: { ...dependencies, prisma: store.prisma as never, sendEmail: sendEmail as never, emailParts: emailParts({ readFile: async () => PDF }) },
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(result.failedIds).toEqual(["message-1"]);
  });
});
