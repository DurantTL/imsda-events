import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/modules/lodging/message-currency", () => ({ lodgingMessageStaleReason: vi.fn() }));

import { resetServerEnvCache } from "@/lib/env";
import { processExternalEmailQueue } from "@/modules/communications/email-delivery";
import { verifyUnsubscribeToken } from "@/modules/communications/email-preferences";

/**
 * Announcement opt-outs at the delivery step (#838). A synthetic outbox row goes through the real delivery loop with a
 * fake database and a fake provider, so nothing is sent anywhere.
 */

const configuration = { apiKey: "re_test_only", apiUrl: "https://api.resend.test" };
const now = () => new Date("2026-07-23T12:00:00.000Z");

type Row = Record<string, unknown> & { id: string; status: string };

function store(overrides: Partial<Row> = {}) {
  const message: Row = {
    id: "message-1",
    eventId: "event-1",
    accountUserId: null,
    accountAttendeeId: null,
    templateKey: "EVENT_ANNOUNCEMENT",
    registrationId: "registration-1",
    recipientEmail: "attendee@example.test",
    senderNameSnapshot: "IMSDA Events",
    senderEmailSnapshot: "registration@imsda.org",
    replyToEmailSnapshot: null,
    subjectSnapshot: "Friday arrival information",
    bodyTextSnapshot: "Doors open at 5 p.m.",
    bodyHtmlSnapshot: "<p>Doors open at 5 p.m.</p>",
    metadata: { essential: false },
    status: "PENDING",
    attemptCount: 0,
    availableAt: new Date("2026-07-23T12:00:00.000Z"),
    lockedAt: null,
    lockToken: null,
    ...overrides,
  };
  const auditRows: Array<Record<string, unknown>> = [];
  const messageOutbox = {
    findMany: vi.fn(async () => []),
    findFirst: vi.fn(async () => (message.status === "PENDING" && (message.availableAt as Date) <= now() ? { ...message, attachment: null, files: [] } : null)),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (where.id !== message.id || (where.status && where.status !== message.status)) return { count: 0 };
      if ("lockToken" in where && where.lockToken !== message.lockToken) return { count: 0 };
      Object.assign(message, data);
      return { count: 1 };
    }),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(message, data)),
  };
  const tx = {
    messageOutbox,
    messageDeliveryAttempt: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      findFirst: vi.fn(async () => null),
      aggregate: vi.fn(async () => ({ _max: { attemptNumber: null } })),
    },
    messageProviderEvent: { updateMany: vi.fn(async () => ({ count: 0 })), findFirst: vi.fn(async () => null) },
    clubFormLink: { updateMany: vi.fn(async () => ({ count: 0 })) },
    healthRecordLink: { updateMany: vi.fn(async () => ({ count: 0 })) },
  };
  const prisma = {
    eventMessageSettings: { findUnique: vi.fn(async () => ({ deliveryMode: "EXTERNAL_EMAIL", senderEmail: "registration@imsda.org" })) },
    messageOutbox,
    invoiceDeliveryRecipient: { findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { auditRows.push(data); }) },
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
  };
  return { prisma, message, auditRows };
}




function run(
  state: ReturnType<typeof store>,
  optOut: "EVENT" | "ALL" | null,
  sendEmail = vi.fn(async (...args: [Record<string, unknown>]) => (void args, { provider: "RESEND" as const, providerMessageId: "provider-1" })),
) {
  return {
    sendEmail,
    done: processExternalEmailQueue("event-1", {
      dependencies: {
        configuration,
        now,
        prisma: state.prisma as never,
        sendEmail: sendEmail as never,
        findAnnouncementOptOut: vi.fn(async () => optOut),
        prepareBodyText: async (input) => ({ bodyText: input.bodyText, bodyHtml: input.bodyHtml ?? null }),
      },
    }),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerEnvCache();
});

describe("announcement opt-outs at delivery (#838)", () => {
  it.each(["EVENT", "ALL"] as const)("does not send to an address that opted out for %s, and records why", async (scope) => {
    const state = store();
    const { sendEmail, done } = run(state, scope);
    const result = await done;
    expect(sendEmail).not.toHaveBeenCalled();
    expect(result.sentIds).toEqual([]);
    expect(state.message.status).toBe("SUPPRESSED");
    expect(String(state.message.lastError)).toMatch(/opted out/i);
    expect(state.auditRows).toEqual([
      expect.objectContaining({ action: "EVENT_ANNOUNCEMENT_SKIPPED_OPTED_OUT", metadata: { messageId: "message-1", scope } }),
    ]);
    // The audit entry names the message and the kind of opt-out, never the address.
    expect(JSON.stringify(state.auditRows)).not.toContain("attendee@example.test");
  });

  it("still sends an announcement an event manager marked essential, to an address that opted out", async () => {
    const state = store({ metadata: { essential: true } });
    const { sendEmail, done } = run(state, "ALL");
    expect((await done).sentIds).toEqual(["message-1"]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it.each([
    "REGISTRATION_CONFIRMATION_PAID",
    "REGISTRATION_CONFIRMATION_UNPAID",
    "PAYMENT_RECEIPT",
    "BALANCE_REMINDER",
    "WAITLIST_JOINED",
    "WAITLIST_PROMOTED",
    "REGISTRATION_TRANSFERRED_NEW_CONTACT",
    "CUSTOM_MESSAGE",
  ])("never applies an opt-out to a %s message", async (templateKey) => {
    const state = store({ templateKey, metadata: {} });
    const lookup = vi.fn(async () => "ALL" as const);
    const sendEmail = vi.fn(async (...args: [Record<string, unknown>]) => (void args, { provider: "RESEND" as const, providerMessageId: "provider-1" }));
    const result = await processExternalEmailQueue("event-1", {
      dependencies: {
        configuration,
        now,
        prisma: state.prisma as never,
        sendEmail: sendEmail as never,
        findAnnouncementOptOut: lookup,
        prepareBodyText: async (input) => ({ bodyText: input.bodyText, bodyHtml: input.bodyHtml ?? null }),
      },
    });
    expect(result.sentIds).toEqual(["message-1"]);
    expect(lookup).not.toHaveBeenCalled();
    // Only announcements carry the unsubscribe link and headers.
    const sent = sendEmail.mock.calls[0][0] as { listUnsubscribe?: unknown; bodyText: string };
    expect(sent.listUnsubscribe ?? null).toBeNull();
    expect(sent.bodyText).not.toMatch(/unsubscribe|announcements/i);
  });

  it("sends an announcement with a signed unsubscribe link, in the body and as one-click headers", async () => {
    vi.stubEnv("APP_BASE_URL", "https://events.imsda.test");
    resetServerEnvCache();
    const state = store();
    const { sendEmail, done } = run(state, null);
    expect((await done).sentIds).toEqual(["message-1"]);
    const sent = sendEmail.mock.calls[0][0] as { listUnsubscribe: { url: string }; bodyText: string; bodyHtml: string };
    expect(sent.listUnsubscribe.url).toMatch(/^https:\/\/events\.imsda\.test\/api\/public\/unsubscribe\/v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const token = sent.listUnsubscribe.url.split("/").pop() as string;
    expect(verifyUnsubscribeToken(token)).toEqual({ email: "attendee@example.test", eventId: "event-1" });
    expect(sent.bodyText).toContain(`https://events.imsda.test/unsubscribe/${token}`);
    expect(sent.bodyHtml).toContain(`/unsubscribe/${token}`);
    // The stored snapshot never holds the link.
    expect(state.message.bodyTextSnapshot).toBe("Doors open at 5 p.m.");
  });

  it("does not send when the opt-out check itself fails, and retries later", async () => {
    const state = store();
    const sendEmail = vi.fn();
    await processExternalEmailQueue("event-1", {
      dependencies: {
        configuration,
        now,
        prisma: state.prisma as never,
        sendEmail: sendEmail as never,
        findAnnouncementOptOut: vi.fn(async () => { throw new Error("database unavailable"); }),
        prepareBodyText: async (input) => ({ bodyText: input.bodyText, bodyHtml: input.bodyHtml ?? null }),
      },
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(state.message.status).toBe("PENDING");
    expect(state.message.attemptCount).toBe(1);
  });
});
