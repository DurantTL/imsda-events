import "server-only";

import { Prisma } from "@prisma/client";
import { getResendEmailAvailability } from "@/integrations/email/resend";
import { getPrisma } from "@/lib/prisma";
import { BATCH_TRANSACTION_MAX_WAIT_MS, BATCH_TRANSACTION_TIMEOUT_MS } from "@/modules/communications/batch-transaction";
import { MessagingError } from "@/modules/communications/messaging-error";
import {
  createMessageRetryCopy,
  ensureEventMessagingDefaults,
} from "@/modules/communications/messaging-repository";
import {
  classifyFailedMessage,
  messageBatchKey,
  RETRY_FAILED_REQUEST_CAP,
  RETRY_FAILED_SKIP_LABELS,
  retryFailedIdempotencyKey,
  retryFailedIdempotencyPrefix,
  retryFailedPreviewFingerprint,
  retryFailedScopeKey,
  type FailedBatchSummary,
  type FailedMessagesRetryPreview,
  type FailedMessagesRetryResult,
  type RetryFailedScope,
  type RetryFailedSkipReason,
  type RetryFailedSkippedSummary,
} from "@/modules/communications/retry-failed-domain";
import type { FailedMessagesRetryInput } from "@/modules/communications/schemas";

const RETRY_FAILED_AUDIT_ACTION = "MESSAGE_RETRY_FAILED_ENQUEUED";

type Db = Prisma.TransactionClient;
type DeliveryMode = "DISABLED" | "LOCAL_CAPTURE" | "EXTERNAL_EMAIL";

type Plan = {
  scope: RetryFailedScope;
  deliveryMode: DeliveryMode;
  failedCount: number;
  eventFailedCount: number;
  eligibleIds: string[];
  queueIds: string[];
  skipped: RetryFailedSkippedSummary[];
  batches: FailedBatchSummary[];
  fingerprint: string;
  blocker: { code: string; message: string } | null;
  senderEmail: string | null;
};

function summarizeSkips(counts: Map<RetryFailedSkipReason, number>): RetryFailedSkippedSummary[] {
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, label: RETRY_FAILED_SKIP_LABELS[reason], count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
}

function deliveryBlocker(deliveryMode: DeliveryMode): Plan["blocker"] {
  if (deliveryMode === "DISABLED") {
    return {
      code: "DELIVERY_DISABLED",
      message: "Turn on message delivery before retrying failed messages.",
    };
  }
  if (deliveryMode === "EXTERNAL_EMAIL" && !getResendEmailAvailability().deliveryConfigured) {
    return {
      code: "EXTERNAL_EMAIL_NOT_CONFIGURED",
      message: "Add the Resend API key before retrying real email.",
    };
  }
  return null;
}

/**
 * Reads the FAILED messages in the scope and decides, for each, whether a retry copy is allowed. Reads only what the
 * decision needs (never a body), so a long delivery log stays cheap.
 */
async function buildPlan(db: Db, eventId: string, scope: RetryFailedScope): Promise<Plan> {
  const settings = await db.eventMessageSettings.findUniqueOrThrow({ where: { eventId } });
  const deliveryMode = settings.deliveryMode as DeliveryMode;

  if (scope.type === "BATCH") {
    // A batch id from another event (or a made-up one) is a 404, never an empty preview that hints it exists.
    const known = await db.messageOutbox.findFirst({
      where: {
        eventId,
        OR: [
          { correlationId: scope.batchId },
          { metadata: { path: ["batchId"], equals: scope.batchId } },
          { metadata: { path: ["sourceBatchId"], equals: scope.batchId } },
        ],
      },
      select: { id: true },
    });
    if (!known) {
      throw new MessagingError("MESSAGE_NOT_FOUND", "That send batch is no longer available.");
    }
  }

  const failed = await db.messageOutbox.findMany({
    where: { eventId, status: "FAILED" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      templateKey: true,
      subjectSnapshot: true,
      createdAt: true,
      registrationId: true,
      senderEmailSnapshot: true,
      correlationId: true,
      metadata: true,
      registration: { select: { status: true } },
      retries: { select: { status: true } },
    },
  });

  const batchMap = new Map<string, FailedBatchSummary>();
  const inScope = failed.filter((message) => {
    const batchId = messageBatchKey(message);
    if (batchId) {
      const existing = batchMap.get(batchId);
      if (existing) existing.failedCount += 1;
      else {
        batchMap.set(batchId, {
          batchId,
          templateKey: message.templateKey,
          subject: message.subjectSnapshot,
          sentAt: message.createdAt.toISOString(),
          failedCount: 1,
        });
      }
    }
    if (scope.type === "EVENT") return true;
    return batchId === scope.batchId || message.correlationId === scope.batchId;
  });

  const skipCounts = new Map<RetryFailedSkipReason, number>();
  const eligibleIds: string[] = [];
  for (const message of inScope) {
    const reason = classifyFailedMessage({
      templateKey: message.templateKey,
      retryStatuses: message.retries.map((retry) => retry.status),
      registrationId: message.registrationId,
      registrationStatus: message.registration?.status ?? null,
      deliveryMode,
      senderEmailSnapshot: message.senderEmailSnapshot,
      settingsSenderEmail: settings.senderEmail,
    });
    if (reason) skipCounts.set(reason, (skipCounts.get(reason) ?? 0) + 1);
    else eligibleIds.push(message.id);
  }

  const queueIds = eligibleIds.slice(0, RETRY_FAILED_REQUEST_CAP);
  return {
    scope,
    deliveryMode,
    failedCount: inScope.length,
    eventFailedCount: failed.length,
    eligibleIds,
    queueIds,
    skipped: summarizeSkips(skipCounts),
    batches: [...batchMap.values()].sort((left, right) => right.sentAt.localeCompare(left.sentAt)),
    fingerprint: retryFailedPreviewFingerprint({
      eventId,
      scope,
      deliveryMode,
      queueMessageIds: queueIds,
      eligibleCount: eligibleIds.length,
    }),
    blocker: deliveryBlocker(deliveryMode),
    senderEmail: settings.senderEmail,
  };
}

/** The review staff see before confirming: counts and skip reasons, never a message body. Read only. */
export async function previewFailedMessagesRetry(
  eventId: string,
  scope: RetryFailedScope,
): Promise<FailedMessagesRetryPreview> {
  await ensureEventMessagingDefaults(eventId);
  const plan = await buildPlan(getPrisma() as unknown as Db, eventId, scope);
  return {
    scope,
    deliveryMode: plan.deliveryMode,
    failedCount: plan.failedCount,
    eligibleCount: plan.eligibleIds.length,
    queueCount: plan.queueIds.length,
    remainingCount: plan.eligibleIds.length - plan.queueIds.length,
    cap: RETRY_FAILED_REQUEST_CAP,
    skipped: plan.skipped,
    blocker: plan.blocker,
    fingerprint: plan.fingerprint,
    batches: plan.batches,
    eventFailedCount: plan.eventFailedCount,
  };
}

function resultFromAudit(
  scope: RetryFailedScope,
  input: FailedMessagesRetryInput,
  audit: { metadata: Prisma.JsonValue | null },
): FailedMessagesRetryResult {
  const metadata = audit.metadata && typeof audit.metadata === "object" && !Array.isArray(audit.metadata)
    ? audit.metadata as Record<string, unknown>
    : {};
  if (
    metadata.previewFingerprint !== input.previewFingerprint
    || metadata.scope !== retryFailedScopeKey(scope)
  ) {
    throw new MessagingError(
      "IDEMPOTENCY_KEY_REUSED",
      "This retry request ID was already used for a different set of messages. Preview the failed messages again.",
    );
  }
  const skipped = Array.isArray(metadata.skipped)
    ? (metadata.skipped as RetryFailedSkippedSummary[])
    : [];
  const mode = metadata.deliveryMode;
  return {
    scope,
    queuedCount: typeof metadata.queuedCount === "number" ? metadata.queuedCount : 0,
    skippedCount: typeof metadata.skippedCount === "number" ? metadata.skippedCount : 0,
    remainingCount: typeof metadata.remainingCount === "number" ? metadata.remainingCount : 0,
    skipped,
    deliveryMode: mode === "DISABLED" || mode === "LOCAL_CAPTURE" || mode === "EXTERNAL_EMAIL"
      ? mode
      : "LOCAL_CAPTURE",
    replayed: true,
  };
}

async function findRecordedOperation(db: Db, eventId: string, clientRequestId: string) {
  return db.auditLog.findFirst({
    where: { eventId, action: RETRY_FAILED_AUDIT_ACTION, correlationId: clientRequestId },
    select: { metadata: true },
  });
}

/**
 * Queues one retry copy for each eligible FAILED message the confirmed preview listed (#860). Staff confirm the exact
 * set (the preview fingerprint); the copies are only queued here, and the outbox worker sends them in batches. A
 * message that already has a retry copy (queued, sent or handled) is skipped, never copied again, and every copy has
 * its own idempotency key, so a double click or a re-post cannot duplicate an email.
 */
export async function retryFailedMessages(
  eventId: string,
  input: FailedMessagesRetryInput,
  actorUserId: string,
): Promise<FailedMessagesRetryResult> {
  await ensureEventMessagingDefaults(eventId);
  const prisma = getPrisma();
  const scope = input.scope;
  try {
    return await prisma.$transaction(async (tx) => {
      const recorded = await findRecordedOperation(tx, eventId, input.clientRequestId);
      if (recorded) return resultFromAudit(scope, input, recorded);

      const plan = await buildPlan(tx, eventId, scope);
      if (plan.blocker) {
        throw new MessagingError(
          plan.blocker.code as "DELIVERY_DISABLED" | "EXTERNAL_EMAIL_NOT_CONFIGURED",
          plan.blocker.message,
        );
      }
      if (plan.fingerprint !== input.previewFingerprint) {
        throw new MessagingError(
          "PREVIEW_CHANGED",
          "The failed messages changed since the preview. Preview them again before retrying.",
        );
      }
      if (plan.queueIds.length === 0) {
        throw new MessagingError(
          "EMPTY_AUDIENCE",
          "No failed message in this scope can be retried.",
        );
      }

      const sources = await tx.messageOutbox.findMany({
        where: { id: { in: plan.queueIds }, eventId, status: "FAILED" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      const settings = await tx.eventMessageSettings.findUniqueOrThrow({ where: { eventId } });
      const queuedIds: string[] = [];
      for (const source of sources) {
        const repairMissingSenderSnapshot = (
          plan.deliveryMode === "EXTERNAL_EMAIL"
          && !source.senderEmailSnapshot?.trim()
        );
        const sourceBatchId = messageBatchKey(source);
        const created = await createMessageRetryCopy(tx, {
          eventId,
          source,
          settings,
          repairMissingSenderSnapshot,
          idempotencyKey: retryFailedIdempotencyKey(eventId, input.clientRequestId, source.id),
          correlationId: input.clientRequestId,
          requestFingerprint: input.previewFingerprint,
          trigger: "STAFF_MESSAGE_RETRY_FAILED",
          extraMetadata: {
            retryFailedRequestId: input.clientRequestId,
            ...(sourceBatchId ? { sourceBatchId } : {}),
          },
        });
        queuedIds.push(created.id);
      }

      const skippedCount = plan.skipped.reduce((total, item) => total + item.count, 0);
      const remainingCount = plan.eligibleIds.length - queuedIds.length;
      // Ids and counts only: no recipient, subject or body.
      await tx.auditLog.create({
        data: {
          eventId,
          actorUserId,
          action: RETRY_FAILED_AUDIT_ACTION,
          entityType: "MessageBatch",
          entityId: `retry-failed:${eventId}:${input.clientRequestId}`,
          correlationId: input.clientRequestId,
          summary: `Queued ${queuedIds.length} retry cop${queuedIds.length === 1 ? "y" : "ies"} of failed messages (${retryFailedScopeKey(scope)}); the outbox worker sends them.`,
          metadata: {
            scope: retryFailedScopeKey(scope),
            previewFingerprint: input.previewFingerprint,
            deliveryMode: plan.deliveryMode,
            queuedCount: queuedIds.length,
            skippedCount,
            remainingCount,
            skipped: plan.skipped.map((item) => ({ reason: item.reason, label: item.label, count: item.count })),
            sourceMessageIds: sources.map((source) => source.id),
            newMessageIds: queuedIds,
            realDelivery: plan.deliveryMode === "EXTERNAL_EMAIL",
          },
        },
      });
      return {
        scope,
        queuedCount: queuedIds.length,
        skippedCount,
        remainingCount,
        skipped: plan.skipped,
        deliveryMode: plan.deliveryMode,
        replayed: false,
      };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: BATCH_TRANSACTION_MAX_WAIT_MS,
      timeout: BATCH_TRANSACTION_TIMEOUT_MS,
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError
      && (error.code === "P2002" || error.code === "P2034")
    ) {
      // A concurrent post of the same request won; report what it recorded rather than queue anything again.
      const recorded = await findRecordedOperation(prisma, eventId, input.clientRequestId);
      if (recorded) return resultFromAudit(scope, input, recorded);
      const partial = await prisma.messageOutbox.findFirst({
        where: {
          eventId,
          idempotencyKey: { startsWith: retryFailedIdempotencyPrefix(eventId, input.clientRequestId) },
        },
        select: { id: true },
      });
      throw new MessagingError(
        "MESSAGE_NOT_RETRYABLE",
        partial
          ? "This retry is still being recorded. Refresh the delivery log in a moment."
          : "Another retry ran at the same time. Preview the failed messages again.",
      );
    }
    throw error;
  }
}
