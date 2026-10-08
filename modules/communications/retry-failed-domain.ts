import { createHash } from "node:crypto";

/**
 * "Retry failed" (#860): one staff action that queues a fresh copy of each FAILED message in a send batch (or in the
 * recent failures of the whole event), never of a message whose email may already have been delivered. Nothing here
 * sends anything; the outbox worker does.
 */

/** The most copies one confirmed request queues. Staff repeat the action for the rest. */
export const RETRY_FAILED_REQUEST_CAP = 250;

/** The event-wide scope retries only recent failures; an older failure is retried by choosing its batch. */
export const RETRY_FAILED_EVENT_SCOPE_DAYS = 7;

export type RetryFailedScope =
  | { type: "EVENT" }
  | { type: "BATCH"; batchId: string };

/** What a preview can ask for: the newest failed batch is resolved by the server. */
export type RetryFailedPreviewScope = RetryFailedScope | { type: "LATEST_BATCH" };

export type RetryFailedSkipReason =
  | "INVOICE"
  | "LINK_CLUB_FORM"
  | "LINK_HEALTH_RECORD"
  | "LINK_CLUB_INVITE"
  | "BALANCE_REMINDER"
  | "ACCESS_RECOVERY"
  | "TOO_OLD"
  | "ALREADY_QUEUED"
  | "ALREADY_RETRIED"
  | "NEWER_COPY_FAILED"
  | "LATER_DELIVERY"
  | "REGISTRATION_NOT_ACTIVE"
  | "MISSING_SENDER";

export const RETRY_FAILED_SKIP_LABELS: Record<RetryFailedSkipReason, string> = {
  INVOICE: "Invoice emails are resent from Finance, Invoices",
  LINK_CLUB_FORM: "Club form links are sent again from More, Club forms (the link belongs to the original message)",
  LINK_HEALTH_RECORD: "Health record links are sent again from More, Health (the link belongs to the original message)",
  LINK_CLUB_INVITE: "New club application invites are sent again from Admin, Club applications (the link belongs to the original message)",
  BALANCE_REMINDER: "Send a fresh balance reminder instead (the amount may have changed)",
  ACCESS_RECOVERY: "A recovery link expires; the registrant can ask for a new one",
  TOO_OLD: `Failed more than ${RETRY_FAILED_EVENT_SCOPE_DAYS} days ago; choose its batch to retry it`,
  ALREADY_QUEUED: "A copy in its retry chain is already queued or being sent",
  ALREADY_RETRIED: "Another message in its retry chain was already sent, captured, suppressed or cancelled",
  NEWER_COPY_FAILED: "A newer copy in its retry chain also failed; that newest copy is retried instead",
  LATER_DELIVERY: "The same person was sent the same email after this one failed",
  REGISTRATION_NOT_ACTIVE: "The registration is no longer active",
  MISSING_SENDER: "No sender is saved for this message or this event",
};

const LINK_EMAIL_REASONS: Record<string, RetryFailedSkipReason> = {
  CLUB_FORM_LINK: "LINK_CLUB_FORM",
  HEALTH_RECORD_LINK: "LINK_HEALTH_RECORD",
  NEW_CLUB_APPLICATION_INVITE: "LINK_CLUB_INVITE",
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
  /** The scope the preview is for; a "newest batch" request is answered with the batch it resolved to. */
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
  /** Set for the event-wide scope: only failures from this many recent days are retried. Null for a batch. */
  eventScopeDays: number | null;
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

/**
 * Why a FAILED message is not retried, or null when it is eligible. The first matching reason wins.
 *
 * A failed message is retried only when nothing in its whole retry tree (the original, every copy and every
 * resend of it) was sent, captured, suppressed or cancelled or is still queued, it is the newest failed message in
 * that tree, and the same person was not sent the same email since. That is the guarantee behind "nobody gets it
 * twice".
 */
export function classifyFailedMessage(input: {
  templateKey: string;
  /** Status of every other message in this message's retry tree. */
  treeStatuses: string[];
  isNewestFailedInTree: boolean;
  /** The same registration and address was sent the same template after this message failed. */
  laterDelivery: boolean;
  tooOld: boolean;
  registrationId: string | null;
  registrationStatus: string | null;
  deliveryMode: string;
  senderEmailSnapshot: string | null;
  settingsSenderEmail: string | null;
}): RetryFailedSkipReason | null {
  if (input.templateKey === "INVOICE_DELIVERY") return "INVOICE";
  const link = LINK_EMAIL_REASONS[input.templateKey];
  if (link) return link;
  if (input.templateKey === "BALANCE_REMINDER") return "BALANCE_REMINDER";
  if (input.templateKey === "REGISTRATION_ACCESS_RECOVERY") return "ACCESS_RECOVERY";
  if (input.treeStatuses.some((status) => ACTIVE_RETRY_STATUSES.has(status))) return "ALREADY_QUEUED";
  if (input.treeStatuses.some((status) => status !== "FAILED")) return "ALREADY_RETRIED";
  if (!input.isNewestFailedInTree) return "NEWER_COPY_FAILED";
  if (input.laterDelivery) return "LATER_DELIVERY";
  if (input.tooOld) return "TOO_OLD";
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

/**
 * Groups messages into retry trees: a message belongs to the tree of the root original reached by following
 * `retryOfMessageId` (a single retry, a resend of a confirmation and a bulk retry all set it). Returns the root id of
 * each message. `parentOf` must hold every node whose parent is set; a parent that is not in the map is the root.
 */
export function retryTreeRoots(
  messageIds: Iterable<string>,
  parentOf: ReadonlyMap<string, string | null>,
) {
  const roots = new Map<string, string>();
  for (const start of messageIds) {
    let current = start;
    const seen = new Set<string>([current]);
    for (;;) {
      const parent = parentOf.get(current);
      if (!parent || seen.has(parent)) break;
      seen.add(parent);
      current = parent;
    }
    roots.set(start, current);
  }
  return roots;
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
