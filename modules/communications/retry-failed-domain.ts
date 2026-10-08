import { createHash } from "node:crypto";

/**
 * "Retry failed" (#860): one staff action that queues a fresh copy of each FAILED message in a send batch (or in the
 * whole event), never of a message that was delivered. Nothing here sends anything; the outbox worker does.
 */

/** The most copies one confirmed request queues. Staff repeat the action for the rest. */
export const RETRY_FAILED_REQUEST_CAP = 250;

export type RetryFailedScope =
  | { type: "EVENT" }
  | { type: "BATCH"; batchId: string };

export type RetryFailedSkipReason =
  | "INVOICE"
  | "ALREADY_QUEUED"
  | "ALREADY_RETRIED"
  | "NEWER_COPY_FAILED"
  | "REGISTRATION_NOT_ACTIVE"
  | "MISSING_SENDER";

export const RETRY_FAILED_SKIP_LABELS: Record<RetryFailedSkipReason, string> = {
  INVOICE: "Invoice emails are resent from Finance, Invoices",
  ALREADY_QUEUED: "A retry copy is already queued or being sent",
  ALREADY_RETRIED: "Already retried (a copy was sent or handled)",
  NEWER_COPY_FAILED: "A newer copy also failed; that copy is retried instead",
  REGISTRATION_NOT_ACTIVE: "The registration is no longer active",
  MISSING_SENDER: "No sender is saved for this message or this event",
};

export type RetryFailedSkippedSummary = {
  reason: RetryFailedSkipReason;
  label: string;
  count: number;
};

export type FailedBatchSummary = {
  batchId: string;
  templateKey: string;
  subject: string;
  /** When the batch was first queued (ISO). */
  sentAt: string;
  failedCount: number;
};

export type FailedMessagesRetryPreview = {
  scope: RetryFailedScope;
  deliveryMode: "DISABLED" | "LOCAL_CAPTURE" | "EXTERNAL_EMAIL";
  /** FAILED messages in the scope. */
  failedCount: number;
  /** Failed messages that may be retried (before the request cap). */
  eligibleCount: number;
  /** Copies one confirmation queues now (eligible, capped). */
  queueCount: number;
  /** Eligible messages left for another confirmation because of the cap. */
  remainingCount: number;
  cap: number;
  skipped: RetryFailedSkippedSummary[];
  /** Set when a confirmation would be refused (delivery off, no provider key). */
  blocker: { code: string; message: string } | null;
  fingerprint: string;
  /** Failed batches of the event, newest first, for the scope picker. */
  batches: FailedBatchSummary[];
  /** FAILED messages in the whole event. */
  eventFailedCount: number;
};

export type FailedMessagesRetryResult = {
  scope: RetryFailedScope;
  queuedCount: number;
  skippedCount: number;
  remainingCount: number;
  skipped: RetryFailedSkippedSummary[];
  deliveryMode: "DISABLED" | "LOCAL_CAPTURE" | "EXTERNAL_EMAIL";
  replayed: boolean;
};

const ACTIVE_RETRY_STATUSES = new Set(["PENDING", "PROCESSING"]);

/** Why a FAILED message is not retried, or null when it is eligible. The first matching reason wins. */
export function classifyFailedMessage(input: {
  templateKey: string;
  retryStatuses: string[];
  registrationId: string | null;
  registrationStatus: string | null;
  deliveryMode: string;
  senderEmailSnapshot: string | null;
  settingsSenderEmail: string | null;
}): RetryFailedSkipReason | null {
  if (input.templateKey === "INVOICE_DELIVERY") return "INVOICE";
  if (input.retryStatuses.some((status) => ACTIVE_RETRY_STATUSES.has(status))) return "ALREADY_QUEUED";
  if (input.retryStatuses.some((status) => status !== "FAILED")) return "ALREADY_RETRIED";
  if (input.retryStatuses.length > 0) return "NEWER_COPY_FAILED";
  if (
    input.registrationId
    && input.registrationStatus !== "SUBMITTED"
    && input.registrationStatus !== "CONFIRMED"
  ) {
    return "REGISTRATION_NOT_ACTIVE";
  }
  if (
    input.deliveryMode === "EXTERNAL_EMAIL"
    && !input.senderEmailSnapshot?.trim()
    && !input.settingsSenderEmail?.trim()
  ) {
    return "MISSING_SENDER";
  }
  return null;
}

export function retryFailedScopeKey(scope: RetryFailedScope) {
  return scope.type === "EVENT" ? "EVENT" : `BATCH:${scope.batchId}`;
}

/** Binds a confirmation to exactly the messages the preview showed. */
export function retryFailedPreviewFingerprint(input: {
  eventId: string;
  scope: RetryFailedScope;
  deliveryMode: string;
  queueMessageIds: string[];
  eligibleCount: number;
}) {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    action: "STAFF_RETRY_FAILED_MESSAGES",
    eventId: input.eventId,
    scope: retryFailedScopeKey(input.scope),
    deliveryMode: input.deliveryMode,
    queueMessageIds: [...input.queueMessageIds].sort(),
    eligibleCount: input.eligibleCount,
  })).digest("hex");
}

/** One key per request; the source message id is appended for each copy, so a re-post can never add a second copy. */
export function retryFailedIdempotencyPrefix(eventId: string, clientRequestId: string) {
  return `message-retry-failed:${eventId}:${clientRequestId}:`;
}

export function retryFailedIdempotencyKey(
  eventId: string,
  clientRequestId: string,
  sourceMessageId: string,
) {
  return `${retryFailedIdempotencyPrefix(eventId, clientRequestId)}${sourceMessageId}`;
}

/** The batch a message belongs to: the id Email selected and other batch sends store, or its retry copy's source batch. */
export function messageBatchKey(message: {
  metadata: unknown;
}): string | null {
  const metadata = message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
    ? message.metadata as Record<string, unknown>
    : {};
  if (typeof metadata.batchId === "string" && metadata.batchId) return metadata.batchId;
  if (typeof metadata.sourceBatchId === "string" && metadata.sourceBatchId) return metadata.sourceBatchId;
  return null;
}
