import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/modules/lodging/message-currency", () => ({ lodgingMessageStaleReason: vi.fn() }));

import { resetServerEnvCache } from "@/lib/env";
import { processExternalEmailQueue } from "@/modules/communications/email-delivery";
import { deriveUnsubscribeToken } from "@/modules/communications/email-preferences";

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
    metadata: { announcementId: "announcement-1" },
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




type Options = {
  optOut?: "EVENT" | "ALL" | null;
  essential?: boolean;
  lookup?: "missing" | "throws";
  sendEmail?: ReturnType<typeof vi.fn>;
};

function dependenciesFor(state: ReturnType<typeof store>, options: Options, sendEmail: ReturnType<typeof vi.fn>) {
  return {
    configuration,
    now,
    prisma: state.prisma as never,
    sendEmail: sendEmail as never,
    ...(options.lookup === "missing"
      ? {}
      : { findAnnouncementOptOut: options.lookup === "throws" ? vi.fn(async () => { throw new Error("database unavailable"); }) : vi.fn(async () => options.optOut ?? null) }),
    isAnnouncementEssential: vi.fn(async () => options.essential === true),
    issueUnsubscribeToken: vi.fn(async (email: string, eventId: string) => deriveUnsubscribeToken({ email, eventId })),
    prepareBodyText: async (input: { bodyText: string; bodyHtml?: string | null }) => ({ bodyText: input.bodyText, bodyHtml: input.bodyHtml ?? null }),
  };
}

function run(state: ReturnType<typeof store>, options: Options = {}) {
  const sendEmail = options.sendEmail ?? vi.fn(async (...args: [Record<string, unknown>]) => (void args, { provider: "RESEND" as const, providerMessageId: "provider-1" }));
  return { sendEmail, done: processExternalEmailQueue("event-1", { dependencies: dependenciesFor(state, options, sendEmail) }) };
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerEnvCache();
});

describe("announcement opt-outs at delivery (#838)", () => {
  it.each(["EVENT", "ALL"] as const)("does not send to an address that opted out for %s, and records why", async (scope) => {
    const state = store();
    const { sendEmail, done } = run(state, { optOut: scope });
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

  it("sends an opted-out address the announcement while it is marked essential, decided at delivery from the announcement", async () => {
    const state = store();
    const { sendEmail, done } = run(state, { optOut: "ALL", essential: true });
    expect((await done).sentIds).toEqual(["message-1"]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("applies a cleared essential mark to a message already queued", async () => {
    const queued = store();
    const stillEssential = run(queued, { optOut: "EVENT", essential: false });
    await stillEssential.done;
    expect(queued.message.status).toBe("SUPPRESSED");
  });

  it("treats a message with no announcement behind it (a staff-chosen batch) as never essential", async () => {
    const state = store({ metadata: { trigger: "STAFF_SELECTED_AUDIENCE" } });
    const { sendEmail, done } = run(state, { optOut: "ALL", essential: true });
    await done;
    expect(sendEmail).not.toHaveBeenCalled();
    expect(state.message.status).toBe("SUPPRESSED");
  });

  it("delivers a retry copy of an essential announcement to an opted-out address, because the copy keeps its announcement id", async () => {
    // A retry copy's metadata, as `createMessageRetryCopy` writes it: the source's announcement id carried over.
    const copy = store({ metadata: { trigger: "STAFF_MESSAGE_RETRY", sourceMessageId: "message-0", announcementId: "announcement-1" } });
    const { done } = run(copy, { optOut: "ALL", essential: true });
    expect((await done).sentIds).toEqual(["message-1"]);
    const lost = store({ metadata: { trigger: "STAFF_MESSAGE_RETRY", sourceMessageId: "message-0" } });
    await run(lost, { optOut: "ALL", essential: true }).done;
    expect(lost.message.status).toBe("SUPPRESSED");
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
    const deps = dependenciesFor(state, { optOut: "ALL" }, vi.fn(async (...args: [Record<string, unknown>]) => (void args, { provider: "RESEND" as const, providerMessageId: "provider-1" })));
    const result = await processExternalEmailQueue("event-1", { dependencies: deps });
    expect(result.sentIds).toEqual(["message-1"]);
    expect(deps.findAnnouncementOptOut).not.toHaveBeenCalled();
    expect(deps.issueUnsubscribeToken).not.toHaveBeenCalled();
    // Only announcements carry the unsubscribe link and headers.
    const sent = (deps.sendEmail as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { listUnsubscribe?: unknown; bodyText: string };
    expect(sent.listUnsubscribe ?? null).toBeNull();
    expect(sent.bodyText).not.toMatch(/unsubscribe|announcements/i);
  });

  it("sends an announcement with an opaque unsubscribe link, in the body and as one-click headers", async () => {
    vi.stubEnv("APP_BASE_URL", "https://events.imsda.test");
    resetServerEnvCache();
    const state = store();
    const { sendEmail, done } = run(state);
    expect((await done).sentIds).toEqual(["message-1"]);
    const sent = sendEmail.mock.calls[0][0] as { listUnsubscribe: { url: string }; bodyText: string; bodyHtml: string };
    const token = deriveUnsubscribeToken({ email: "attendee@example.test", eventId: "event-1" });
    expect(sent.listUnsubscribe.url).toBe(`https://events.imsda.test/api/public/unsubscribe/${token}`);
    expect(sent.listUnsubscribe.url).not.toMatch(/attendee|example\.test\/|event-1/);
    expect(sent.bodyText).toContain(`https://events.imsda.test/unsubscribe/${token}`);
    expect(sent.bodyHtml).toContain(`/unsubscribe/${token}`);
    // The stored snapshot never holds the link.
    expect(state.message.bodyTextSnapshot).toBe("Doors open at 5 p.m.");
  });

  it("fails closed when the opt-out check fails: nothing is sent and the message is retried", async () => {
    const state = store();
    const { sendEmail, done } = run(state, { lookup: "throws" });
    await done;
    expect(sendEmail).not.toHaveBeenCalled();
    expect(state.message.status).toBe("PENDING");
    expect(state.message.attemptCount).toBe(1);
  });

  it("fails closed when no opt-out lookup is available at all", async () => {
    const state = store();
    const { sendEmail, done } = run(state, { lookup: "missing" });
    await done;
    expect(sendEmail).not.toHaveBeenCalled();
    expect(state.message.status).toBe("PENDING");
    expect(state.message.attemptCount).toBe(1);
  });

  it("treats a failure to issue the unsubscribe link as a retryable, generic error and stores no raw error text", async () => {
    const state = store();
    const deps = dependenciesFor(state, {}, vi.fn());
    deps.issueUnsubscribeToken = vi.fn(async () => { throw new Error("connection refused at db.internal:5432 password=hunter2"); });
    await processExternalEmailQueue("event-1", { dependencies: deps });
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(state.message.status).toBe("PENDING");
    expect(state.message.attemptCount).toBe(1);
    expect(String(state.message.lastError)).toMatch(/unsubscribe link could not be prepared/i);
    expect(JSON.stringify(state.message)).not.toMatch(/hunter2|db\.internal|connection refused/);
  });

  it("looks the announcement up within the message's own event, so another event's announcement id is never essential", async () => {
    const announcement = {
      findFirst: vi.fn(async ({ where }: { where: { id: string; eventId: string } }) => (
        where.id === "announcement-1" && where.eventId === "event-1" ? { isEssential: true } : null
      )),
    };
    const own = store();
    const ownDeps = dependenciesFor(own, { optOut: "ALL" }, vi.fn(async (...args: [Record<string, unknown>]) => (void args, { provider: "RESEND" as const, providerMessageId: "p-1" })));
    delete (ownDeps as Partial<typeof ownDeps>).isAnnouncementEssential;
    (own.prisma as unknown as Record<string, unknown>).announcement = announcement;
    expect((await processExternalEmailQueue("event-1", { dependencies: ownDeps })).sentIds).toEqual(["message-1"]);
    expect(announcement.findFirst).toHaveBeenCalledWith({ where: { id: "announcement-1", eventId: "event-1" }, select: { isEssential: true } });

    // The same id, but the message belongs to a different event: not found there, so not essential, so skipped.
    const other = store({ eventId: "event-2" });
    const otherSend = vi.fn();
    const otherDeps = dependenciesFor(other, { optOut: "ALL" }, otherSend);
    delete (otherDeps as Partial<typeof otherDeps>).isAnnouncementEssential;
    (other.prisma as unknown as Record<string, unknown>).announcement = announcement;
    await processExternalEmailQueue("event-1", { dependencies: otherDeps });
    expect(otherSend).not.toHaveBeenCalled();
    expect(other.message.status).toBe("SUPPRESSED");
  });

  it("checks the opt-out again just before the provider call, so an opt-out made while the message was queued is honoured", async () => {
    const state = store();
    const sendEmail = vi.fn();
    const deps = dependenciesFor(state, {}, sendEmail);
    // Not opted out when the message is claimed; opted out by the time its body is prepared.
    const lookup = vi.fn<(email: string, eventId: string) => Promise<"EVENT" | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("EVENT");
    deps.findAnnouncementOptOut = lookup as never;
    await processExternalEmailQueue("event-1", { dependencies: deps });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(state.message.status).toBe("SUPPRESSED");
    expect(String(state.message.lastError)).toMatch(/opted out/i);
  });

  it("still sends an essential announcement when the second check finds an opt-out", async () => {
    const state = store();
    const deps = dependenciesFor(state, { essential: true }, vi.fn(async (...args: [Record<string, unknown>]) => (void args, { provider: "RESEND" as const, providerMessageId: "p-2" })));
    deps.findAnnouncementOptOut = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("ALL") as never;
    expect((await processExternalEmailQueue("event-1", { dependencies: deps })).sentIds).toEqual(["message-1"]);
  });
});

