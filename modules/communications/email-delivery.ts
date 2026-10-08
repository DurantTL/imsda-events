import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  EmailProviderConfigurationError,
  EmailProviderRequestError,
  getResendEmailConfiguration,
  sendEmailWithResend,
  type ResendEmailConfiguration,
} from "@/integrations/email/resend";
import { getServerEnv } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import {
  mapResendDeliveryEvent,
  providerTransitionUpdate,
} from "@/modules/communications/provider-events";
import {
  REGISTRATION_MANAGE_API_SENTINEL,
  REGISTRATION_MANAGE_LINK_SENTINEL,
} from "@/modules/communications/manage-link";
import { renderEmailHtmlDocument } from "@/modules/communications/email-html";
import {
  AccountEmailNotConfiguredError,
  getAccountEmailSender,
  prepareAccountEmailBodyForDelivery,
} from "@/modules/communications/account-email";
import { prepareAttendeeEmailBodyForDelivery } from "@/modules/attendee-accounts/attendee-email";
import {
  CLUB_FORM_LINK_TEMPLATE_KEY,
  prepareClubFormLinkBodyForDelivery,
  retireClubFormLinkForMessage,
} from "@/modules/club-forms/link-email";
import {
  NEW_CLUB_APPLICATION_INVITE_TEMPLATE_KEY,
  prepareNewClubInviteBodyForDelivery,
  retireNewClubInviteForMessage,
} from "@/modules/club-applications/email";
import {
  HEALTH_RECORD_LINK_TEMPLATE_KEY,
  prepareHealthRecordLinkBodyForDelivery,
  retireHealthRecordLinkForMessage,
} from "@/modules/health-records/link-email";
import { logError, logWarn } from "@/lib/logger";
import { MessageFileDeliveryError } from "@/modules/communications/message-file-rules";
import {
  BoundedFileCache,
  buildEmailParts,
  type DeliveryFileLink,
  type EmailPartDependencies,
} from "@/modules/communications/email-attachments";
import { readMessageFileBytes } from "@/modules/communications/message-files";
import {
  createStableRegistrationAccessToken,
  revokeRegistrationAccessToken,
} from "@/modules/public-access/repository";
import { registrationRecoveryAccessExpiry } from "@/modules/public-access/domain";

export const MAX_EMAIL_DELIVERY_ATTEMPTS = 5;
export const EMAIL_DELIVERY_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
export const EMAIL_DELIVERY_BATCH_SIZE = 50;
const EMAIL_RETRY_BASE_MS = 60 * 1000;
const EMAIL_RETRY_MAX_MS = 60 * 60 * 1000;
// A provider quota does not clear in minutes (Resend's free plan resets daily), so it backs off in hours (#860).
const EMAIL_QUOTA_RETRY_BASE_MS = 2 * 60 * 60 * 1000;
const EMAIL_QUOTA_RETRY_MAX_MS = 24 * 60 * 60 * 1000;
export const PROVIDER_QUOTA_ERROR_CODE = "PROVIDER_QUOTA";
export const PROVIDER_RATE_LIMITED_ERROR_CODE = "PROVIDER_RATE_LIMITED";
export const PROVIDER_RATE_LIMITED_MESSAGE = "The email provider is limiting how fast messages can be sent. The message will be tried again shortly.";
export const PROVIDER_QUOTA_MESSAGE = "The email provider's sending limit was reached. The message will be tried again later; staff can also retry it from the delivery log once the limit resets.";

type DeliveryPrisma = Pick<
  PrismaClient,
  "$transaction" | "eventMessageSettings" | "messageOutbox" | "auditLog" | "invoiceDeliveryRecipient"
>;

export type ExternalEmailDeliveryDependencies = {
  prisma?: DeliveryPrisma;
  now?: () => Date;
  configuration?: ResendEmailConfiguration;
  sendEmail?: typeof sendEmailWithResend;
  prepareBodyText?: (input: EmailBodyPreparationInput) => Promise<PreparedEmailBody>;
  /** How stored files and pass images are read for embedding (#824); the defaults read private storage and render in-process. */
  emailParts?: Partial<EmailPartDependencies>;
};

export type ExternalEmailQueueResult = {
  recoveredIds: string[];
  sentIds: string[];
  failedIds: string[];
  rescheduledIds: string[];
};

/**
 * Which slice of the outbox a run owns. Event messages take their sender from
 * the event's settings; account messages have no event and take theirs from the
 * `ACCOUNT_EMAIL_*` variables. Everything between claiming and finalising is
 * identical, so both share this worker.
 */
export type OutboxScope = { eventId: string } | { eventId: null };

type ClaimedMessage = {
  id: string;
  eventId: string | null;
  accountUserId: string | null;
  accountAttendeeId: string | null;
  templateKey: string;
  registrationId: string | null;
  recipientEmail: string;
  senderNameSnapshot: string;
  senderEmailSnapshot: string | null;
  replyToEmailSnapshot: string | null;
  subjectSnapshot: string;
  bodyTextSnapshot: string;
  bodyHtmlSnapshot: string | null;
  /** The one file sent with the message, when it has one (#168: an invoice PDF), read from the shared attachment row. */
  attachment?: { filename: string; contentType: string; sha256: string; content: Uint8Array } | null;
  /** The files staff attached and the images embedded in the body (#824), from the outbox row's own references. */
  files?: DeliveryFileLink[];
  attemptCount: number;
  lockToken: string;
  startedAt: Date;
};

export type PreparedEmailBody = {
  bodyText: string;
  bodyHtml?: string | null;
  revokeOnDefinitiveFailure?: () => Promise<void>;
};

export type EmailBodyPreparationInput = {
  messageId: string;
  registrationId: string | null;
  accountUserId?: string | null;
  accountAttendeeId?: string | null;
  templateKey?: string;
  bodyText: string;
  bodyHtml?: string | null;
  now: Date;
};

export async function prepareEmailBodyForDelivery(
  input: EmailBodyPreparationInput,
): Promise<PreparedEmailBody> {
  // Both bodies carry the same sentinels and both must be resolved from the
  // same token, or the formatted mail and its fallback would offer different
  // links — or one of them a raw sentinel.
  const carriesSentinel = (value: string | null | undefined) => Boolean(
    value
    && (value.includes(REGISTRATION_MANAGE_LINK_SENTINEL)
      || value.includes(REGISTRATION_MANAGE_API_SENTINEL)),
  );
  if (!carriesSentinel(input.bodyText) && !carriesSentinel(input.bodyHtml)) {
    return { bodyText: input.bodyText, bodyHtml: input.bodyHtml ?? null };
  }
  if (!input.registrationId) {
    throw new Error(
      "A registration message cannot insert a private link without a registration."
    );
  }

  const appBaseUrl = getServerEnv().APP_BASE_URL;
  const access = await createStableRegistrationAccessToken({
    registrationId: input.registrationId,
    deliveryKey: `message:${input.messageId}`,
    now: input.now,
    expiresAt: input.templateKey === "REGISTRATION_ACCESS_RECOVERY"
      ? registrationRecoveryAccessExpiry(input.now)
      : undefined,
    renewExpired: input.templateKey === "REGISTRATION_ACCESS_RECOVERY",
  });
  const manageUrl = new URL(access.managePath, appBaseUrl).toString();
  // One token serves both the page a registrant opens and the pass image their
  // mail client fetches, so a confirmation carries a single grant of access.
  const manageApiUrl = new URL(
    `/api/public/manage/${access.token}`,
    appBaseUrl,
  ).toString();
  const resolveSentinels = (value: string) => value
    .replaceAll(REGISTRATION_MANAGE_API_SENTINEL, manageApiUrl)
    .replaceAll(REGISTRATION_MANAGE_LINK_SENTINEL, manageUrl);
  return {
    bodyText: resolveSentinels(input.bodyText),
    bodyHtml: input.bodyHtml ? resolveSentinels(input.bodyHtml) : null,
    revokeOnDefinitiveFailure: async () => {
      await revokeRegistrationAccessToken(access.token);
    },
  };
}

export type NormalizedEmailDeliveryError = {
  code: string;
  message: string;
  retryable: boolean;
};

export class ExternalEmailDeliveryError extends Error {
  constructor(
    public readonly code:
      | "EXTERNAL_EMAIL_NOT_ENABLED"
      | "EXTERNAL_EMAIL_NOT_CONFIGURED"
      | "ACCOUNT_EMAIL_NOT_CONFIGURED",
    message: string,
  ) {
    super(message);
    this.name = "ExternalEmailDeliveryError";
  }
}

export function emailRetryDelayMs(attemptNumber: number, errorCode?: string | null) {
  const exponent = Math.max(0, Math.min(10, attemptNumber - 1));
  if (errorCode === PROVIDER_QUOTA_ERROR_CODE) {
    return Math.min(EMAIL_QUOTA_RETRY_MAX_MS, EMAIL_QUOTA_RETRY_BASE_MS * (2 ** exponent));
  }
  return Math.min(EMAIL_RETRY_MAX_MS, EMAIL_RETRY_BASE_MS * (2 ** exponent));
}

/** A 429 whose provider error name is a daily or monthly quota (Resend: daily_quota_exceeded, monthly_quota_exceeded). */
export function isProviderQuotaError(error: EmailProviderRequestError) {
  return error.status === 429 && /quota/i.test(error.code);
}

/** A 429 for the short per-second limit (Resend: rate_limit_exceeded). It clears in moments, so it keeps the minute backoff. */
export function isProviderRateLimitError(error: EmailProviderRequestError) {
  return error.status === 429 && /rate[_ -]?limit/i.test(error.code) && !/quota/i.test(error.code);
}

export function normalizeEmailDeliveryError(error: unknown): NormalizedEmailDeliveryError {
  // A stored file that could not be read: a generic message (never a path), retryable only for transient I/O.
  if (error instanceof MessageFileDeliveryError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof EmailProviderRequestError) {
    if (isProviderRateLimitError(error)) {
      return {
        code: PROVIDER_RATE_LIMITED_ERROR_CODE,
        message: PROVIDER_RATE_LIMITED_MESSAGE,
        retryable: true,
      };
    }
    if (isProviderQuotaError(error)) {
      return {
        code: PROVIDER_QUOTA_ERROR_CODE,
        message: PROVIDER_QUOTA_MESSAGE,
        retryable: true,
      };
    }
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  if (error instanceof EmailProviderConfigurationError) {
    return {
      code: "PROVIDER_CONFIGURATION_ERROR",
      message: error.message,
      retryable: false,
    };
  }
  if (error instanceof TypeError) {
    return {
      code: "PROVIDER_NETWORK_ERROR",
      message: "The email provider could not be reached.",
      retryable: true,
    };
  }
  return {
    code: "UNEXPECTED_PROVIDER_ERROR",
    message: error instanceof Error ? error.message : "The email provider request failed.",
    retryable: false,
  };
}

function resolvePrisma(dependencies: ExternalEmailDeliveryDependencies) {
  return dependencies.prisma ?? getPrisma();
}

/**
 * One file is read and hash-checked once per delivery run, however many messages carry it: an announcement to a
 * few hundred registrations sends the same attachment each time.
 */
function resolveEmailPartDependencies(
  dependencies: ExternalEmailDeliveryDependencies,
  fileCache: BoundedFileCache,
): EmailPartDependencies {
  const overrides = dependencies.emailParts ?? {};
  const read = overrides.readFile ?? readMessageFileBytes;
  return {
    readFile: (file) => fileCache.read(file.id, () => read(file)),
    renderQrPng: overrides.renderQrPng ?? (async (registrationAccessToken, attendeeId) => {
      const [{ createAuthorizedAttendeePass }, { renderAttendeePassQrPng }] = await Promise.all([
        import("@/modules/checkin/attendee-pass-repository"),
        import("@/modules/checkin/pass-qr-image"),
      ]);
      const pass = await createAuthorizedAttendeePass(registrationAccessToken, attendeeId);
      return pass ? renderAttendeePassQrPng(pass.token) : null;
    }),
    appOrigin: overrides.appOrigin ?? (() => {
      try {
        return new URL(getServerEnv().APP_BASE_URL).origin;
      } catch {
        return null;
      }
    }),
  };
}

function resolveConfiguration(dependencies: ExternalEmailDeliveryDependencies) {
  try {
    return dependencies.configuration ?? getResendEmailConfiguration();
  } catch (error) {
    if (error instanceof EmailProviderConfigurationError) {
      throw new ExternalEmailDeliveryError(
        "EXTERNAL_EMAIL_NOT_CONFIGURED",
        error.message
      );
    }
    throw error;
  }
}

/** Cancels (and audits, ids only) a lodging email that a later change made wrong before it went out (#200). */
async function cancelIfLodgingStale(
  prisma: DeliveryPrisma,
  message: ClaimedMessage,
  at: Date,
) {
  if (message.templateKey !== "LODGING_ASSIGNMENT_NOTICE" && message.templateKey !== "LODGING_WAITLIST_OFFER") return false;
  let reason: string | null;
  try {
    const { lodgingMessageStaleReason } = await import("@/modules/lodging/message-currency");
    reason = await lodgingMessageStaleReason(message.id, message.templateKey);
  } catch (error) {
    // The check itself failed: count it as a failed attempt and retry after the normal backoff (so it ends as FAILED after
    // the usual number of tries, and staff can offer again), and carry on with the rest of the run.
    logError("Unable to check whether a lodging email is still current; it will be retried.", error);
    await finalizeFailedAttempt(prisma, message, { code: "LODGING_CURRENCY_CHECK_FAILED", message: "Could not confirm the lodging email was still current, so it was not sent.", retryable: true }, at, true);
    return true;
  }
  if (!reason) return false;
  const updated = await prisma.messageOutbox.updateMany({
    where: { id: message.id, status: "PROCESSING", lockToken: message.lockToken },
    data: { status: "CANCELLED", lockedAt: null, lockToken: null, lastError: reason },
  });
  if (updated.count === 1) {
    await prisma.auditLog.create({
      data: {
        eventId: message.eventId,
        action: "LODGING_MESSAGE_CANCELLED",
        entityType: "MessageOutbox",
        entityId: message.id,
        correlationId: randomUUID(),
        summary: "Cancelled a lodging email because it was out of date before it was sent.",
        metadata: { messageId: message.id, templateKey: message.templateKey },
      },
    });
  }
  return true;
}

const INVOICE_REPLACED_REASON = "Invoice version superseded";

/** Cancels (and audits, ids only) an invoice message whose version is no longer FINALIZED. Returns true when it did. */
async function cancelIfInvoiceReplaced(
  prisma: DeliveryPrisma,
  message: { id: string; eventId: string | null; templateKey: string; lockToken: string },
) {
  if (message.templateKey !== "INVOICE_DELIVERY") return false;
  const replaced = await prisma.invoiceDeliveryRecipient.findFirst({
    where: { messageOutboxId: message.id, delivery: { invoiceVersion: { status: { not: "FINALIZED" } } } },
    select: { id: true },
  });
  if (!replaced) return false;
  const updated = await prisma.messageOutbox.updateMany({
    where: { id: message.id, status: "PROCESSING", lockToken: message.lockToken },
    data: { status: "CANCELLED", lockedAt: null, lockToken: null, lastError: "The invoice was replaced by a newer version before this was sent." },
  });
  if (updated.count === 1) {
    await prisma.auditLog.create({
      data: {
        eventId: message.eventId,
        action: "INVOICE_MESSAGE_CANCELLED",
        entityType: "MessageOutbox",
        entityId: message.id,
        correlationId: randomUUID(),
        summary: "Cancelled an invoice email because its invoice version was superseded.",
        metadata: { messageId: message.id, reason: INVOICE_REPLACED_REASON },
      },
    });
  }
  return true;
}

async function recoverStaleClaims(
  prisma: DeliveryPrisma,
  scope: OutboxScope,
  messageIds: string[] | undefined,
  now: Date,
) {
  const staleBefore = new Date(now.getTime() - EMAIL_DELIVERY_LOCK_TIMEOUT_MS);
  const candidates = await prisma.messageOutbox.findMany({
    where: {
      ...scope,
      status: "PROCESSING",
      lockedAt: { lte: staleBefore },
      ...(messageIds ? { id: { in: messageIds } } : {}),
    },
    orderBy: { lockedAt: "asc" },
    take: EMAIL_DELIVERY_BATCH_SIZE,
    select: {
      id: true,
      attemptCount: true,
      lockToken: true,
      lockedAt: true,
    },
  });
  const recoveredIds: string[] = [];
  for (const candidate of candidates) {
    const recovered = await prisma.$transaction(async (tx) => {
      const recoveryToken = randomUUID();
      const reserved = await tx.messageOutbox.updateMany({
        where: {
          id: candidate.id,
          status: "PROCESSING",
          lockToken: candidate.lockToken,
          lockedAt: candidate.lockedAt,
        },
        data: { lockToken: recoveryToken },
      });
      if (reserved.count !== 1) return false;

      const attemptNumber = candidate.attemptCount + 1;
      const terminal = attemptNumber >= MAX_EMAIL_DELIVERY_ATTEMPTS;
      const completedAt = now;
      const availableAt = new Date(now.getTime() + emailRetryDelayMs(attemptNumber));
      await tx.messageDeliveryAttempt.create({
        data: {
          messageOutboxId: candidate.id,
          attemptNumber: await nextAttemptRowNumber(tx, candidate.id, candidate.attemptCount),
          provider: "RESEND",
          status: "FAILED",
          errorCode: "STALE_DELIVERY_LOCK",
          errorMessage: terminal
            ? "The email worker stopped before completing this attempt."
            : "The email worker stopped before completing this attempt; the message was rescheduled.",
          providerMetadata: {
            retryable: !terminal,
            recoveredStaleLock: true,
            ...(terminal ? {} : { nextAvailableAt: availableAt.toISOString() }),
          },
          startedAt: candidate.lockedAt ?? completedAt,
          completedAt,
        },
      });
      await tx.messageOutbox.update({
        where: { id: candidate.id },
        data: {
          status: terminal ? "FAILED" : "PENDING",
          attemptCount: attemptNumber,
          availableAt: terminal ? completedAt : availableAt,
          lockedAt: null,
          lockToken: null,
          failedAt: terminal ? completedAt : null,
          providerDeliveryStatus: terminal ? "FAILED" : undefined,
          providerStatusAt: terminal ? completedAt : undefined,
          lastError: terminal
            ? "Email delivery stopped before completion after the maximum number of attempts."
            : "Email delivery stopped before completion and was rescheduled.",
        },
      });
      // Out of attempts: a club form link that never arrived must not stay live (#610). A message with no link matches nothing.
      if (terminal) {
        await retireClubFormLinkForMessage(tx, candidate.id, completedAt);
        await retireHealthRecordLinkForMessage(tx, candidate.id, completedAt);
      }
      return true;
    });
    if (recovered) recoveredIds.push(candidate.id);
  }
  return recoveredIds;
}

async function claimNextMessage(
  prisma: DeliveryPrisma,
  scope: OutboxScope,
  messageIds: string[] | undefined,
  now: Date,
): Promise<ClaimedMessage | null> {
  for (let collision = 0; collision < 5; collision += 1) {
    const lockToken = randomUUID();
    const claimed = await prisma.$transaction(async (tx) => {
      const message = await tx.messageOutbox.findFirst({
        where: {
          ...scope,
          status: "PENDING",
          availableAt: { lte: now },
          attemptCount: { lt: MAX_EMAIL_DELIVERY_ATTEMPTS },
          ...(messageIds ? { id: { in: messageIds } } : {}),
        },
        orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          eventId: true,
          accountUserId: true,
          accountAttendeeId: true,
          templateKey: true,
          registrationId: true,
          recipientEmail: true,
          senderNameSnapshot: true,
          senderEmailSnapshot: true,
          replyToEmailSnapshot: true,
          subjectSnapshot: true,
          bodyTextSnapshot: true,
          bodyHtmlSnapshot: true,
          attachment: { select: { filename: true, contentType: true, sha256: true, content: true } },
          files: {
            orderBy: [{ disposition: "asc" }, { position: "asc" }],
            select: {
              disposition: true,
              file: { select: { id: true, filename: true, contentType: true, sizeBytes: true, sha256: true, storageKey: true } },
            },
          },
          attemptCount: true,
        },
      });
      if (!message) return { kind: "empty" as const };
      const updated = await tx.messageOutbox.updateMany({
        where: {
          id: message.id,
          status: "PENDING",
          availableAt: { lte: now },
          attemptCount: message.attemptCount,
        },
        data: {
          status: "PROCESSING",
          lockToken,
          lockedAt: now,
        },
      });
      if (updated.count !== 1) return { kind: "collision" as const };
      return {
        kind: "claimed" as const,
        message: {
          ...message,
          lockToken,
          startedAt: now,
        },
      };
    });
    if (claimed.kind === "empty") return null;
    if (claimed.kind === "claimed") return claimed.message;
  }
  return null;
}

/**
 * The row number of the next attempt. A quota deferral (#860) is recorded but not counted in `attemptCount`, so the
 * two can differ: numbering from the highest row keeps (message, attemptNumber) unique.
 */
async function nextAttemptRowNumber(
  tx: Pick<PrismaClient, "messageDeliveryAttempt">,
  messageId: string,
  attemptCount: number,
) {
  const highest = await tx.messageDeliveryAttempt.aggregate({
    where: { messageOutboxId: messageId },
    _max: { attemptNumber: true },
  });
  return Math.max(attemptCount, highest._max.attemptNumber ?? 0) + 1;
}

async function finalizeSuccessfulAttempt(
  prisma: DeliveryPrisma,
  message: ClaimedMessage,
  providerMessageId: string,
  completedAt: Date,
) {
  const attemptNumber = message.attemptCount + 1;
  const providerIdempotencyKey = `outbox:${message.id}`;
  return prisma.$transaction(async (tx) => {
    const finalized = await tx.messageOutbox.updateMany({
      where: {
        id: message.id,
        status: "PROCESSING",
        lockToken: message.lockToken,
      },
      data: {
        status: "SENT",
        attemptCount: attemptNumber,
        sentAt: completedAt,
        provider: "RESEND",
        providerMessageId,
        providerDeliveryStatus: "ACCEPTED",
        providerStatusAt: completedAt,
        lockedAt: null,
        lockToken: null,
        lastError: null,
      },
    });
    if (finalized.count !== 1) return false;
    await tx.messageDeliveryAttempt.create({
      data: {
        messageOutboxId: message.id,
        attemptNumber: await nextAttemptRowNumber(tx, message.id, message.attemptCount),
        provider: "RESEND",
        status: "SENT",
        providerMessageId,
        providerMetadata: {
          providerDeliveryStatus: "ACCEPTED",
          idempotencyKey: providerIdempotencyKey,
          realDelivery: true,
        },
        startedAt: message.startedAt,
        completedAt,
      },
    });

    await tx.messageProviderEvent.updateMany({
      where: {
        provider: "RESEND",
        providerMessageId,
        messageOutboxId: null,
      },
      data: { messageOutboxId: message.id },
    });
    const latestEvent = await tx.messageProviderEvent.findFirst({
      where: {
        provider: "RESEND",
        providerMessageId,
        mappedDeliveryStatus: { not: null },
      },
      orderBy: [{ occurredAt: "desc" }, { receivedAt: "desc" }],
      select: {
        eventType: true,
        occurredAt: true,
      },
    });
    const transition = latestEvent
      ? mapResendDeliveryEvent(latestEvent.eventType, latestEvent.occurredAt)
      : null;
    if (transition) {
      await tx.messageOutbox.update({
        where: { id: message.id },
        data: providerTransitionUpdate(transition),
      });
    }
    return true;
  });
}

async function finalizeFailedAttempt(
  prisma: DeliveryPrisma,
  message: ClaimedMessage,
  error: NormalizedEmailDeliveryError,
  completedAt: Date,
  internal = false,
) {
  const attemptNumber = message.attemptCount + 1;
  // A provider quota is the provider's limit, not this message's fault: it never uses up an attempt, so it can never
  // be what ends the message as FAILED (#860). It is recorded and rescheduled with the hours backoff.
  const quota = error.code === PROVIDER_QUOTA_ERROR_CODE && !internal;
  const reschedule = quota || (error.retryable && attemptNumber < MAX_EMAIL_DELIVERY_ATTEMPTS);
  let availableAt = new Date(completedAt.getTime() + emailRetryDelayMs(attemptNumber, error.code));
  const finalized = await prisma.$transaction(async (tx) => {
    const rowNumber = await nextAttemptRowNumber(tx, message.id, message.attemptCount);
    if (quota) {
      // Each quota rejection backs off longer than the last: the exponent counts the attempts recorded so far.
      const recorded = await tx.messageDeliveryAttempt.aggregate({
        where: { messageOutboxId: message.id },
        _max: { attemptNumber: true },
      });
      availableAt = new Date(completedAt.getTime() + emailRetryDelayMs((recorded._max.attemptNumber ?? 0) + 1, error.code));
    }
    const updated = await tx.messageOutbox.updateMany({
      where: {
        id: message.id,
        status: "PROCESSING",
        lockToken: message.lockToken,
      },
      data: {
        status: reschedule ? "PENDING" : "FAILED",
        attemptCount: quota ? message.attemptCount : attemptNumber,
        availableAt: reschedule ? availableAt : completedAt,
        lockedAt: null,
        lockToken: null,
        failedAt: reschedule ? null : completedAt,
        provider: internal ? undefined : "RESEND",
        providerDeliveryStatus: reschedule || internal ? undefined : "FAILED",
        providerStatusAt: reschedule || internal ? undefined : completedAt,
        lastError: error.message,
      },
    });
    if (updated.count !== 1) return false;
    await tx.messageDeliveryAttempt.create({
      data: {
        messageOutboxId: message.id,
        attemptNumber: rowNumber,
        provider: internal ? "INTERNAL" : "RESEND",
        status: "FAILED",
        errorCode: error.code,
        errorMessage: error.message,
        providerMetadata: {
          retryable: error.retryable,
          rescheduled: reschedule,
          ...(quota ? { quotaDeferred: true } : {}),
          ...(reschedule ? { nextAvailableAt: availableAt.toISOString() } : {}),
          idempotencyKey: `outbox:${message.id}`,
          // A failed pre-send check (no provider was called) is not a real delivery attempt.
          realDelivery: !internal,
        },
        startedAt: message.startedAt,
        completedAt,
      },
    });
    return true;
  });
  return { finalized, rescheduled: finalized && reschedule, quota: finalized && quota };
}

async function runDeliveryLoop(
  scope: OutboxScope,
  options: {
    messageIds?: string[];
    limit?: number;
    dependencies?: ExternalEmailDeliveryDependencies;
  },
): Promise<ExternalEmailQueueResult> {
  const dependencies = options.dependencies ?? {};
  const prisma = resolvePrisma(dependencies);
  const configuration = resolveConfiguration(dependencies);
  const sendEmail = dependencies.sendEmail ?? sendEmailWithResend;
  const now = dependencies.now ?? (() => new Date());
  const fileCache = new BoundedFileCache();
  const uniqueMessageIds = options.messageIds
    ? [...new Set(options.messageIds)]
    : undefined;
  const limit = Math.max(
    1,
    Math.min(EMAIL_DELIVERY_BATCH_SIZE, options.limit ?? EMAIL_DELIVERY_BATCH_SIZE)
  );

  const recoveredIds = await recoverStaleClaims(
    prisma,
    scope,
    uniqueMessageIds,
    now()
  );
  const result: ExternalEmailQueueResult = {
    recoveredIds,
    sentIds: [],
    failedIds: [],
    rescheduledIds: [],
  };
  for (let processed = 0; processed < limit; processed += 1) {
    const message = await claimNextMessage(
      prisma,
      scope,
      uniqueMessageIds,
      now()
    );
    if (!message) break;
    // An invoice email is sent only while its version is still FINALIZED (#168): one a revision replaced is cancelled, never sent.
    if (await cancelIfInvoiceReplaced(prisma, message)) continue;
    if (await cancelIfLodgingStale(prisma, message, now())) continue;
    let preparedBody: PreparedEmailBody | null = null;
    try {
      const prepareBodyText = dependencies.prepareBodyText
        ?? (scope.eventId === null
          ? prepareAccountEmailBody
          : prepareEmailBodyForDelivery);
      preparedBody = await prepareBodyText({
        messageId: message.id,
        registrationId: message.registrationId,
        accountUserId: message.accountUserId,
        accountAttendeeId: message.accountAttendeeId,
        templateKey: message.templateKey,
        bodyText: message.bodyTextSnapshot,
        bodyHtml: message.bodyHtmlSnapshot,
        now: message.startedAt,
      });
      // A stored attachment must still be the file that was recorded; a mismatch is a definitive failure, never a send.
      if (message.attachment && createHash("sha256").update(message.attachment.content).digest("hex") !== message.attachment.sha256) {
        throw new Error("The attachment no longer matches its recorded hash, so the message was not sent.");
      }
      // Staff attachments and embedded images (#824). Built from the row's own file references on every attempt, so a
      // retry sends exactly what the first attempt would have.
      const parts = await buildEmailParts(
        { bodyHtml: preparedBody.bodyHtml ?? null, files: message.files ?? [] },
        resolveEmailPartDependencies(dependencies, fileCache),
      );
      if (parts.unembeddedImageCount > 0) {
        // Not an error (the QR's remote address still works), but worth seeing if it becomes common.
        logWarn("Check-in QR images were left as remote links.", { messageId: message.id, count: parts.unembeddedImageCount });
      }
      // Checked again immediately before the provider call, so a revision that committed while the body was prepared cannot slip one out.
      if (await cancelIfInvoiceReplaced(prisma, message)) continue;
      if (await cancelIfLodgingStale(prisma, message, now())) continue;
      const delivery = await sendEmail({
        fromName: message.senderNameSnapshot,
        fromEmail: message.senderEmailSnapshot ?? "",
        toEmail: message.recipientEmail,
        replyToEmail: message.replyToEmailSnapshot,
        subject: message.subjectSnapshot,
        bodyText: preparedBody.bodyText,
        // Wrapped, not rendered: the body fragment was rendered at enqueue from
        // the same template and context as the text snapshot, where trusted and
        // untrusted token spans were still distinguishable. A row queued before
        // HTML bodies existed has none, and goes out as text only rather than
        // being re-parsed as Markdown here.
        bodyHtml: parts.bodyHtml
          ? renderEmailHtmlDocument({
            title: message.subjectSnapshot,
            bodyHtml: parts.bodyHtml,
            footer: message.senderNameSnapshot,
          })
          : null,
        attachments: message.attachment || parts.attachments.length > 0
          ? [
              ...(message.attachment
                ? [{ filename: message.attachment.filename, contentType: message.attachment.contentType, content: message.attachment.content }]
                : []),
              ...parts.attachments,
            ]
          : undefined,
        idempotencyKey: `outbox:${message.id}`,
        messageId: message.id,
      }, configuration);
      if (await finalizeSuccessfulAttempt(
        prisma,
        message,
        delivery.providerMessageId,
        now(),
      )) {
        result.sentIds.push(message.id);
      }
    } catch (caught) {
      const normalized = normalizeEmailDeliveryError(caught);
      if (!normalized.retryable && preparedBody?.revokeOnDefinitiveFailure) {
        try {
          await preparedBody.revokeOnDefinitiveFailure();
        } catch (revokeError) {
          logError("Unable to revoke an unused private registration link after a definitive email failure.", revokeError);
        }
      }
      const failure = await finalizeFailedAttempt(
        prisma,
        message,
        normalized,
        now()
      );
      if (failure.rescheduled) result.rescheduledIds.push(message.id);
      // The provider's quota is spent: stop this run so the rest of the queue waits instead of each message
      // making a doomed call (#860). They stay queued and untouched.
      if (failure.quota) break;
      if (!failure.rescheduled && failure.finalized) {
        result.failedIds.push(message.id);
        // Out of retries or non-retryable: a club form link that never arrived must not stay live (#610).
        if (message.templateKey === CLUB_FORM_LINK_TEMPLATE_KEY) {
          try {
            await retireClubFormLinkForMessage(prisma as unknown as PrismaClient, message.id, now());
          } catch (retireError) {
            logError("Unable to withdraw a club form link after its email finally failed.", retireError);
          }
        }
        if (message.templateKey === NEW_CLUB_APPLICATION_INVITE_TEMPLATE_KEY) {
          try {
            await retireNewClubInviteForMessage(prisma as unknown as PrismaClient, message.id, now());
          } catch (retireError) {
            logError("Unable to withdraw a new club application link after its email finally failed.", retireError);
          }
        }
        if (message.templateKey === HEALTH_RECORD_LINK_TEMPLATE_KEY) {
          try {
            await retireHealthRecordLinkForMessage(prisma as unknown as PrismaClient, message.id, now());
          } catch (retireError) {
            logError("Unable to withdraw a health record link after its email finally failed.", retireError);
          }
        }
      }
    }
  }
  return result;
}

/**
 * The eventless slice holds two populations now: staff activation and reset,
 * which mint a one-time link, and attendee verification, which mints a code.
 * Which one a message is comes from its template key rather than from which id
 * column happens to be set, so a row with neither is a clear error instead of a
 * message that silently sends its sentinel to a person.
 */
async function prepareAccountEmailBody(
  input: EmailBodyPreparationInput,
): Promise<PreparedEmailBody> {
  // A club form's private link (#610): the token is minted here, at delivery.
  if (input.templateKey === CLUB_FORM_LINK_TEMPLATE_KEY) {
    return prepareClubFormLinkBodyForDelivery({
      messageId: input.messageId,
      bodyText: input.bodyText,
      now: input.now,
    });
  }
  // A Health Record private link (#611): the token is minted here, at delivery.
  if (input.templateKey === HEALTH_RECORD_LINK_TEMPLATE_KEY) {
    return prepareHealthRecordLinkBodyForDelivery({
      messageId: input.messageId,
      bodyText: input.bodyText,
      now: input.now,
    });
  }
  // New club application email (#817): only the invite carries a sentinel; the rest carry free text and must never be rewritten.
  if (input.templateKey === NEW_CLUB_APPLICATION_INVITE_TEMPLATE_KEY) {
    return prepareNewClubInviteBodyForDelivery({
      messageId: input.messageId,
      bodyText: input.bodyText,
      now: input.now,
    });
  }
  if (input.templateKey?.startsWith("NEW_CLUB_APPLICATION_")) {
    return { bodyText: input.bodyText };
  }
  // Module request email (#741) carries free text and no sentinel: never replace anything in it.
  if (input.templateKey?.startsWith("MODULE_REQUEST_")) {
    return { bodyText: input.bodyText };
  }
  if (input.templateKey?.startsWith("ATTENDEE_")) {
    return prepareAttendeeEmailBodyForDelivery({
      messageId: input.messageId,
      accountAttendeeId: input.accountAttendeeId ?? null,
      templateKey: input.templateKey,
      bodyText: input.bodyText,
      now: input.now,
    });
  }
  return prepareAccountEmailBodyForDelivery({
    messageId: input.messageId,
    accountUserId: input.accountUserId ?? null,
    templateKey: input.templateKey ?? "",
    bodyText: input.bodyText,
    now: input.now,
  });
}

export async function processExternalEmailQueue(
  eventId: string,
  options: {
    messageIds?: string[];
    limit?: number;
    dependencies?: ExternalEmailDeliveryDependencies;
  } = {},
): Promise<ExternalEmailQueueResult> {
  const prisma = resolvePrisma(options.dependencies ?? {});
  const settings = await prisma.eventMessageSettings.findUnique({
    where: { eventId },
    select: { deliveryMode: true, senderEmail: true },
  });
  if (settings?.deliveryMode !== "EXTERNAL_EMAIL") {
    throw new ExternalEmailDeliveryError(
      "EXTERNAL_EMAIL_NOT_ENABLED",
      "Real email delivery is not enabled for this event."
    );
  }
  if (!settings.senderEmail?.trim()) {
    throw new ExternalEmailDeliveryError(
      "EXTERNAL_EMAIL_NOT_CONFIGURED",
      "Add a verified sender email before sending real email."
    );
  }
  return runDeliveryLoop({ eventId }, options);
}

/**
 * The account slice of the outbox: activation and password reset, which have no
 * event to be enabled by and are therefore governed by the `ACCOUNT_EMAIL_*`
 * variables alone. Production requires those at startup, so an unconfigured
 * account queue is a development state, not a silent production one.
 */
export async function processAccountEmailQueue(
  options: {
    messageIds?: string[];
    limit?: number;
    dependencies?: ExternalEmailDeliveryDependencies;
  } = {},
): Promise<ExternalEmailQueueResult> {
  try {
    getAccountEmailSender();
  } catch (error) {
    if (error instanceof AccountEmailNotConfiguredError) {
      throw new ExternalEmailDeliveryError(
        "ACCOUNT_EMAIL_NOT_CONFIGURED",
        error.message,
      );
    }
    throw error;
  }
  return runDeliveryLoop({ eventId: null }, options);
}
