import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  processExternalEmailQueue: vi.fn(),
  deliveryConfigured: true,
}));

vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/integrations/email/resend", () => ({
  getResendEmailAvailability: () => ({
    deliveryConfigured: mocks.deliveryConfigured,
    webhookConfigured: false,
  }),
}));
vi.mock("@/modules/communications/email-delivery", () => ({
  ExternalEmailDeliveryError: class ExternalEmailDeliveryError extends Error {},
  processExternalEmailQueue: mocks.processExternalEmailQueue,
}));

import {
  previewFailedMessagesRetry,
  retryFailedMessages,
} from "@/modules/communications/retry-failed";
import { RETRY_FAILED_REQUEST_CAP } from "@/modules/communications/retry-failed-domain";

type Row = {
  id: string;
  eventId: string;
  registrationId: string | null;
  registrationStatus: string | null;
  templateVersionId: string | null;
  templateKey: string;
  recipientKind: string;
  recipientEmail: string;
  recipientName: string | null;
  senderNameSnapshot: string;
  senderEmailSnapshot: string | null;
  replyToEmailSnapshot: string | null;
  subjectSnapshot: string;
  bodyTextSnapshot: string;
  bodyHtmlSnapshot: string | null;
  attachmentId: string | null;
  metadata: Record<string, unknown> | null;
  idempotencyKey: string;
  correlationId: string;
  status: string;
  retryOfMessageId: string | null;
  createdAt: Date;
};

const batchId = "batch-welcome-1";

function row(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    eventId: "event-1",
    registrationId: `registration-${id}`,
    registrationStatus: "CONFIRMED",
    templateVersionId: "template-version-1",
    templateKey: "CUSTOM_MESSAGE",
    recipientKind: "REGISTRANT",
    recipientEmail: `${id}@example.test`,
    recipientName: `Synthetic ${id}`,
    senderNameSnapshot: "IMSDA Events",
    senderEmailSnapshot: "registration@example.test",
    replyToEmailSnapshot: null,
    subjectSnapshot: "Welcome",
    bodyTextSnapshot: "Welcome body",
    bodyHtmlSnapshot: null,
    attachmentId: null,
    metadata: { trigger: "STAFF_SELECTED_AUDIENCE_BATCH", batchId },
    idempotencyKey: `source:${id}`,
    correlationId: batchId,
    status: "FAILED",
    retryOfMessageId: null,
    createdAt: new Date(Date.now() - 60 * 60 * 1000),
    ...overrides,
  };
}

function fixture(
  initial: Row[],
  settingsOverrides: Record<string, unknown> = {},
) {
  const messages = new Map(initial.map((message) => [message.id, message]));
  const settings = {
    deliveryMode: "EXTERNAL_EMAIL",
    senderName: "IMSDA Events",
    senderEmail: "registration@example.test",
    replyToEmail: null,
    internalNotificationEmails: [],
    ...settingsOverrides,
  };
  const audits: Array<{ correlationId: string; metadata: Record<string, unknown>; action: string }> = [];
  let nextId = 0;
  const tx = {
    platformSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    eventMessageSettings: {
      upsert: vi.fn().mockResolvedValue({}),
      findUniqueOrThrow: vi.fn(async () => settings),
    },
    eventMessageTemplate: {
      upsert: vi.fn().mockResolvedValue({ id: "template-existing", versions: [{ id: "version-existing" }] }),
    },
    messageTemplateVersion: { create: vi.fn() },
    messageOutboxFile: {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    messageTemplateVersionFile: { findMany: vi.fn().mockResolvedValue([]) },
    messageFile: { findMany: vi.fn().mockResolvedValue([]) },
    messageOutbox: {
      findFirst: vi.fn(async (args: { where: { eventId?: string; OR?: unknown[]; idempotencyKey?: { startsWith: string } } }) => {
        if (args.where.idempotencyKey) {
          return [...messages.values()].find((message) => message.idempotencyKey.startsWith(args.where.idempotencyKey!.startsWith)) ?? null;
        }
        // The batch-known check: any message of this event in the batch (any status).
        const batch = JSON.stringify(args.where.OR);
        return [...messages.values()].find((message) => message.eventId === args.where.eventId
          && batch.includes(JSON.stringify(message.correlationId))
          ) ?? null;
      }),
      findMany: vi.fn(async (args: {
        where: {
          eventId?: string;
          status?: string | { in: string[] };
          id?: { in: string[] };
          retryOfMessageId?: unknown;
          registrationId?: { in: string[] };
          templateKey?: { in: string[] };
        };
      }) => {
        const where = args.where;
        const all = [...messages.values()];
        if (where.id) {
          // The sources about to be copied (still FAILED) and the roots of the retry trees (any status).
          return where.id.in
            .map((id) => messages.get(id))
            .filter((message): message is Row => Boolean(message)
              && (where.status === undefined || message!.status === where.status));
        }
        if (where.retryOfMessageId) {
          return all.filter((message) => message.eventId === where.eventId && message.retryOfMessageId !== null);
        }
        if (where.registrationId) {
          const statuses = (where.status as { in: string[] }).in;
          return all.filter((message) => message.eventId === where.eventId
            && statuses.includes(message.status)
            && where.registrationId!.in.includes(message.registrationId ?? "")
            && where.templateKey!.in.includes(message.templateKey));
        }
        return all
          .filter((message) => message.eventId === where.eventId && message.status === where.status)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
          .map((message) => ({
            ...message,
            registration: message.registrationStatus ? { status: message.registrationStatus } : null,
          }));
      }),
      create: vi.fn(async (args: { data: Row }) => {
        for (const existing of messages.values()) {
          if (existing.idempotencyKey === args.data.idempotencyKey) {
            throw new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" });
          }
        }
        nextId += 1;
        const created = { ...args.data, id: `copy-${nextId}`, status: "PENDING", createdAt: new Date(), registrationStatus: null } as unknown as Row;
        messages.set(created.id, created);
        return { id: created.id, status: "PENDING" };
      }),
    },
    auditLog: {
      findFirst: vi.fn(async (args: { where: { correlationId: string; action: string } }) => audits.find(
        (audit) => audit.correlationId === args.where.correlationId && audit.action === args.where.action,
      ) ?? null),
      create: vi.fn(async (args: { data: { correlationId: string; metadata: Record<string, unknown>; action: string } }) => {
        audits.push(args.data);
        return {};
      }),
    },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
  };
  mocks.getPrisma.mockReturnValue(prisma);
  return { messages, tx, prisma, audits };
}

const requestId = "0a01f2cb-efaa-48da-9059-9d7b4510488a";
const batchScope = { type: "BATCH" as const, batchId };

async function confirm(scope = batchScope, id = requestId) {
  const preview = await previewFailedMessagesRetry("event-1", scope);
  return retryFailedMessages(
    "event-1",
    { clientRequestId: id, scope, previewFingerprint: preview.fingerprint },
    "staff-1",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deliveryConfigured = true;
});

describe("retry failed messages", () => {
  it("copies only the failed messages of a batch and never the sent ones, and sends nothing in the request", async () => {
    const db = fixture([
      row("failed-1"),
      row("failed-2"),
      row("sent-1", { status: "SENT" }),
      row("sent-2", { status: "SENT" }),
    ]);

    const result = await confirm();

    expect(result).toMatchObject({ queuedCount: 2, skippedCount: 0, remainingCount: 0, replayed: false, deliveryMode: "EXTERNAL_EMAIL" });
    const copies = [...db.messages.values()].filter((message) => message.retryOfMessageId);
    expect(copies.map((copy) => copy.retryOfMessageId).sort()).toEqual(["failed-1", "failed-2"]);
    expect(copies.every((copy) => copy.status === "PENDING")).toBe(true);
    // Each copy keeps the same recipient, body and registration, and is linked to its batch.
    expect(copies[0]).toMatchObject({ recipientEmail: "failed-1@example.test", bodyTextSnapshot: "Welcome body", registrationId: "registration-failed-1" });
    expect(copies[0]!.metadata).toMatchObject({ trigger: "STAFF_MESSAGE_RETRY_FAILED", sourceBatchId: batchId, sourceMessageId: "failed-1" });
    // Nobody who already got the email gets a copy.
    expect([...db.messages.values()].filter((message) => message.retryOfMessageId?.startsWith("sent"))).toEqual([]);
    // The outbox worker sends them, not this request.
    expect(mocks.processExternalEmailQueue).not.toHaveBeenCalled();
    expect(db.audits).toHaveLength(1);
    expect(JSON.stringify(db.audits[0]!.metadata)).not.toContain("@example.test");
  });

  it("replays an identical re-post without creating a second copy", async () => {
    const db = fixture([row("failed-1"), row("failed-2")]);
    const preview = await previewFailedMessagesRetry("event-1", batchScope);
    const input = { clientRequestId: requestId, scope: batchScope, previewFingerprint: preview.fingerprint };

    const first = await retryFailedMessages("event-1", input, "staff-1");
    const again = await retryFailedMessages("event-1", input, "staff-1");

    expect(first.replayed).toBe(false);
    expect(again).toMatchObject({ replayed: true, queuedCount: 2 });
    expect([...db.messages.values()].filter((message) => message.retryOfMessageId)).toHaveLength(2);
    expect(db.audits).toHaveLength(1);
  });

  it("refuses the same request id with a different scope or preview", async () => {
    fixture([row("failed-1")]);
    const preview = await previewFailedMessagesRetry("event-1", batchScope);
    await retryFailedMessages("event-1", { clientRequestId: requestId, scope: batchScope, previewFingerprint: preview.fingerprint }, "staff-1");

    await expect(retryFailedMessages(
      "event-1",
      { clientRequestId: requestId, scope: { type: "EVENT" }, previewFingerprint: preview.fingerprint },
      "staff-1",
    )).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("a second confirmation with a new request id adds nothing: those messages already have a copy", async () => {
    const db = fixture([row("failed-1"), row("failed-2")]);
    await confirm();

    const fresh = await previewFailedMessagesRetry("event-1", batchScope);
    // The copies are still queued, so the originals are skipped as already queued.
    expect(fresh.eligibleCount).toBe(0);
    expect(fresh.skipped).toEqual([expect.objectContaining({ reason: "ALREADY_QUEUED", count: 2 })]);
    await expect(retryFailedMessages(
      "event-1",
      { clientRequestId: "5a8fb5a6-7f4a-4d30-b09f-0bbd2b8fb7a1", scope: batchScope, previewFingerprint: fresh.fingerprint },
      "staff-1",
    )).rejects.toMatchObject({ code: "EMPTY_AUDIENCE" });
    expect([...db.messages.values()].filter((message) => message.retryOfMessageId)).toHaveLength(2);
  });

  it("skips invoices, already retried, inactive registrations and a missing sender, with a count for each reason", async () => {
    const db = fixture([
      row("ok"),
      row("invoice", { templateKey: "INVOICE_DELIVERY" }),
      row("retried"),
      row("retried-copy", { status: "SENT", retryOfMessageId: "retried", registrationId: null, registrationStatus: null }),
      row("queued"),
      row("queued-copy", { status: "PENDING", retryOfMessageId: "queued", registrationId: null, registrationStatus: null }),
      row("cancelled-registration", { registrationStatus: "CANCELLED" }),
      row("no-sender", { senderEmailSnapshot: null }),
    ], { senderEmail: null });

    const preview = await previewFailedMessagesRetry("event-1", { type: "EVENT" });

    expect(preview.failedCount).toBe(6);
    expect(preview.eligibleCount).toBe(1);
    expect(Object.fromEntries(preview.skipped.map((item) => [item.reason, item.count]))).toEqual({
      INVOICE: 1,
      ALREADY_RETRIED: 1,
      ALREADY_QUEUED: 1,
      REGISTRATION_NOT_ACTIVE: 1,
      MISSING_SENDER: 1,
    });
    expect(preview.skipped.every((item) => item.label.length > 0)).toBe(true);

    const result = await confirm({ type: "EVENT" } as never);
    expect(result.queuedCount).toBe(1);
    expect(result.skippedCount).toBe(5);
    expect([...db.messages.values()].filter((message) => message.retryOfMessageId && message.id.startsWith("copy-")).map((copy) => copy.retryOfMessageId)).toEqual(["ok"]);
  });

  it("retries the newest failed copy, not the original it replaced", async () => {
    fixture([
      row("original", { createdAt: new Date(Date.now() - 2 * 3600_000) }),
      row("copy-that-failed", { retryOfMessageId: "original", registrationId: "registration-original", metadata: { sourceBatchId: batchId } }),
    ]);
    const preview = await previewFailedMessagesRetry("event-1", batchScope);
    expect(preview.eligibleCount).toBe(1);
    expect(preview.skipped).toEqual([expect.objectContaining({ reason: "NEWER_COPY_FAILED", count: 1 })]);
  });

  it("caps one request and reports what is left", async () => {
    const many = Array.from({ length: RETRY_FAILED_REQUEST_CAP + 5 }, (_, index) => row(`failed-${String(index).padStart(4, "0")}`));
    const db = fixture(many);

    const result = await confirm();

    expect(result.queuedCount).toBe(RETRY_FAILED_REQUEST_CAP);
    expect(result.remainingCount).toBe(5);
    expect([...db.messages.values()].filter((message) => message.retryOfMessageId)).toHaveLength(RETRY_FAILED_REQUEST_CAP);
  });

  it("refuses a confirmation whose preview no longer matches", async () => {
    const db = fixture([row("failed-1"), row("failed-2")]);
    const preview = await previewFailedMessagesRetry("event-1", batchScope);
    // Another staff member retried one of them in the meantime.
    db.messages.set("copy-x", row("copy-x", { status: "SENT", retryOfMessageId: "failed-1", registrationId: null, registrationStatus: null }));

    await expect(retryFailedMessages(
      "event-1",
      { clientRequestId: requestId, scope: batchScope, previewFingerprint: preview.fingerprint },
      "staff-1",
    )).rejects.toMatchObject({ code: "PREVIEW_CHANGED" });
    expect([...db.messages.values()].filter((message) => message.id.startsWith("copy-") && message.id !== "copy-x")).toEqual([]);
  });

  it("treats a batch of another event as not found", async () => {
    fixture([row("failed-1")]);
    await expect(previewFailedMessagesRetry("event-1", { type: "BATCH", batchId: "batch-of-another-event" }))
      .rejects.toMatchObject({ code: "MESSAGE_NOT_FOUND" });
  });

  it("refuses when delivery is off or the email provider is not configured", async () => {
    fixture([row("failed-1")], { deliveryMode: "DISABLED" });
    const off = await previewFailedMessagesRetry("event-1", batchScope);
    expect(off.blocker).toMatchObject({ code: "DELIVERY_DISABLED" });
    await expect(retryFailedMessages("event-1", { clientRequestId: requestId, scope: batchScope, previewFingerprint: off.fingerprint }, "staff-1"))
      .rejects.toMatchObject({ code: "DELIVERY_DISABLED" });

    mocks.deliveryConfigured = false;
    fixture([row("failed-1")]);
    const unconfigured = await previewFailedMessagesRetry("event-1", batchScope);
    expect(unconfigured.blocker).toMatchObject({ code: "EXTERNAL_EMAIL_NOT_CONFIGURED" });
  });

  it("lists failed batches with their template and counts for the scope picker", async () => {
    fixture([row("failed-1"), row("failed-2"), row("other", { metadata: { batchId: "batch-b" }, correlationId: "batch-b", templateKey: "BALANCE_REMINDER" }), row("single", { metadata: null, correlationId: "single-c" })]);
    const preview = await previewFailedMessagesRetry("event-1", { type: "EVENT" });
    expect(preview.eventFailedCount).toBe(4);
    expect(preview.batches.map((batch) => [batch.batchId, batch.failedCount]).sort()).toEqual([["batch-b", 1], [batchId, 2]]);
  });

  it("never retries a sibling copy after a single retry of the original was sent (A fails, copy B fails, a single retry of A is SENT)", async () => {
    const db = fixture([
      row("A"),
      row("B", { retryOfMessageId: "A", status: "FAILED", registrationId: null, registrationStatus: null, metadata: { sourceBatchId: batchId }, correlationId: "req-bulk" }),
      row("C", { retryOfMessageId: "A", status: "SENT", registrationId: null, registrationStatus: null, correlationId: "req-single" }),
    ]);
    const preview = await previewFailedMessagesRetry("event-1", batchScope);
    expect(preview.failedCount).toBe(2);
    expect(preview.eligibleCount).toBe(0);
    expect(Object.fromEntries(preview.skipped.map((item) => [item.reason, item.count]))).toEqual({ ALREADY_RETRIED: 2 });
    await expect(retryFailedMessages(
      "event-1",
      { clientRequestId: requestId, scope: batchScope, previewFingerprint: preview.fingerprint },
      "staff-1",
    )).rejects.toMatchObject({ code: "EMPTY_AUDIENCE" });
    expect([...db.messages.values()].filter((message) => message.id.startsWith("copy-"))).toEqual([]);
  });

  it("walks a deep chain and retries only the newest failure when nothing in the tree was sent", async () => {
    fixture([
      row("A", { createdAt: new Date(Date.now() - 5 * 3600_000) }),
      row("B", { retryOfMessageId: "A", createdAt: new Date(Date.now() - 4 * 3600_000), metadata: { sourceBatchId: batchId } }),
      row("C", { retryOfMessageId: "B", createdAt: new Date(Date.now() - 3 * 3600_000), metadata: { sourceBatchId: batchId } }),
    ]);
    const preview = await previewFailedMessagesRetry("event-1", batchScope);
    expect(preview.eligibleCount).toBe(1);
    expect(preview.skipped).toEqual([expect.objectContaining({ reason: "NEWER_COPY_FAILED", count: 2 })]);
  });

  it("counts a resend of a confirmation (also linked by retryOfMessageId, possibly to another address) as delivered", async () => {
    fixture([
      row("confirmation", { templateKey: "REGISTRATION_CONFIRMATION_PAID" }),
      row("resend", {
        templateKey: "REGISTRATION_CONFIRMATION_PAID",
        retryOfMessageId: "confirmation",
        status: "SENT",
        recipientEmail: "other-address@example.test",
        metadata: { trigger: "STAFF_CONFIRMATION_RESEND", sourceMessageId: "confirmation" },
        registrationId: null,
        registrationStatus: null,
      }),
    ]);
    const preview = await previewFailedMessagesRetry("event-1", { type: "EVENT" });
    expect(preview.eligibleCount).toBe(0);
    expect(preview.skipped).toEqual([expect.objectContaining({ reason: "ALREADY_RETRIED", count: 1 })]);
  });

  it("skips a failed message when the same person was sent the same email in a separate, later send", async () => {
    fixture([
      row("failed-1", { createdAt: new Date(Date.now() - 3 * 3600_000) }),
      row("later-send", { status: "SENT", registrationId: "registration-failed-1", registrationStatus: "CONFIRMED", recipientEmail: "FAILED-1@example.test", metadata: { batchId: "another-batch" }, correlationId: "another-batch", createdAt: new Date(Date.now() - 3600_000) }),
      row("failed-2", { createdAt: new Date(Date.now() - 3 * 3600_000) }),
      // Sent earlier than failed-2 failed, or to a different address, so it does not count.
      row("earlier-send", { status: "SENT", registrationId: "registration-failed-2", recipientEmail: "failed-2@example.test", metadata: { batchId: "older" }, correlationId: "older", createdAt: new Date(Date.now() - 6 * 3600_000) }),
    ]);
    const preview = await previewFailedMessagesRetry("event-1", batchScope);
    expect(preview.failedCount).toBe(2);
    expect(preview.eligibleCount).toBe(1);
    expect(preview.skipped).toEqual([expect.objectContaining({ reason: "LATER_DELIVERY", count: 1 })]);
  });

  it("skips a failed message when a later send of the same email to the same person is still queued", async () => {
    fixture([
      row("failed-1", { createdAt: new Date(Date.now() - 3 * 3600_000) }),
      row("queued-later", { status: "PENDING", registrationId: "registration-failed-1", recipientEmail: "failed-1@example.test", metadata: { batchId: "another-batch" }, correlationId: "another-batch", createdAt: new Date(Date.now() - 3600_000) }),
      row("processing-later", { status: "PROCESSING", registrationId: "registration-failed-2", recipientEmail: "failed-2@example.test", metadata: { batchId: "another-batch" }, correlationId: "another-batch", createdAt: new Date(Date.now() - 3600_000) }),
      row("failed-2", { createdAt: new Date(Date.now() - 3 * 3600_000) }),
      row("failed-3", { createdAt: new Date(Date.now() - 3 * 3600_000) }),
    ]);
    const preview = await previewFailedMessagesRetry("event-1", batchScope);
    expect(preview.failedCount).toBe(3);
    expect(preview.eligibleCount).toBe(1);
    expect(preview.skipped).toEqual([expect.objectContaining({ reason: "LATER_QUEUED", count: 2 })]);
  });

  it("skips link emails and balance reminders, each with its own reason", async () => {
    fixture([
      row("ok"),
      row("form", { templateKey: "CLUB_FORM_LINK" }),
      row("health", { templateKey: "HEALTH_RECORD_LINK" }),
      row("invite", { templateKey: "NEW_CLUB_APPLICATION_INVITE" }),
      row("balance", { templateKey: "BALANCE_REMINDER" }),
    ]);
    const preview = await previewFailedMessagesRetry("event-1", batchScope);
    expect(Object.fromEntries(preview.skipped.map((item) => [item.reason, item.count]))).toEqual({
      LINK_CLUB_FORM: 1, LINK_HEALTH_RECORD: 1, LINK_CLUB_INVITE: 1, BALANCE_REMINDER: 1,
    });
    expect(preview.eligibleCount).toBe(1);
  });

  it("limits the event-wide scope to recent failures, shows the limit, and leaves a batch uncapped", async () => {
    fixture([
      row("recent"),
      row("old", { createdAt: new Date(Date.now() - 10 * 24 * 3600_000), metadata: { batchId: "old-batch" }, correlationId: "old-batch" }),
    ]);
    const wide = await previewFailedMessagesRetry("event-1", { type: "EVENT" });
    expect(wide.eventScopeDays).toBe(7);
    expect(wide.eligibleCount).toBe(1);
    expect(wide.skipped).toEqual([expect.objectContaining({ reason: "TOO_OLD", count: 1 })]);
    const oldBatch = await previewFailedMessagesRetry("event-1", { type: "BATCH", batchId: "old-batch" });
    expect(oldBatch.eventScopeDays).toBeNull();
    expect(oldBatch.eligibleCount).toBe(1);
  });

  it("opens on the newest failed batch, and on the whole event when none has a batch", async () => {
    fixture([
      row("a1", { metadata: { batchId: "batch-old" }, correlationId: "batch-old", createdAt: new Date(Date.now() - 5 * 3600_000) }),
      row("b1", { metadata: { batchId: "batch-new" }, correlationId: "batch-new", createdAt: new Date(Date.now() - 3600_000) }),
    ]);
    const latest = await previewFailedMessagesRetry("event-1", { type: "LATEST_BATCH" });
    expect(latest.scope).toEqual({ type: "BATCH", batchId: "batch-new" });
    expect(latest.failedCount).toBe(1);
    fixture([row("single", { metadata: null, correlationId: "single-x" })]);
    expect((await previewFailedMessagesRetry("event-1", { type: "LATEST_BATCH" })).scope).toEqual({ type: "EVENT" });
  });

  it("keeps a single-retry copy in its source's batch", async () => {
    const { createMessageRetryCopy } = await import("@/modules/communications/messaging-repository");
    const db = fixture([row("failed-1")]);
    const source = db.messages.get("failed-1")!;
    await createMessageRetryCopy(db.tx as never, {
      eventId: "event-1",
      source: source as never,
      settings: { deliveryMode: "EXTERNAL_EMAIL", senderName: "x", senderEmail: "a@example.test", replyToEmail: null },
      repairMissingSenderSnapshot: false,
      idempotencyKey: "single-copy-key",
      correlationId: "single-request",
      requestFingerprint: "f".repeat(64),
    });
    const copy = [...db.messages.values()].find((message) => message.idempotencyKey === "single-copy-key")!;
    expect(copy.metadata).toMatchObject({ trigger: "STAFF_MESSAGE_RETRY", sourceBatchId: batchId });
  });
});
