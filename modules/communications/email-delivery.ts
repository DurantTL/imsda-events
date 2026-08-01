import "server-only";

import { randomUUID } from "node:crypto";
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
import { logError } from "@/lib/logger";
import {
  createStableRegistrationAccessToken,
  revokeRegistrationAccessToken,
} from "@/modules/public-access/repository";

export const MAX_EMAIL_DELIVERY_ATTEMPTS = 5;
export const EMAIL_DELIVERY_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
export const EMAIL_DELIVERY_BATCH_SIZE = 50;
const EMAIL_RETRY_BASE_MS = 60 * 1000;
const EMAIL_RETRY_MAX_MS = 60 * 60 * 1000;

type DeliveryPrisma = Pick<
  PrismaClient,
  "$transaction" | "eventMessageSettings" | "messageOutbox" | "auditLog"
>;

export type ExternalEmailDeliveryDependencies = {
  prisma?: DeliveryPrisma;
  now?: () => Date;
  configuration?: ResendEmailConfiguration;
  sendEmail?: typeof sendEmailWithResend;
  prepareBodyText?: (input: EmailBodyPreparationInput) => Promise<PreparedEmailBody>;
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

export function emailRetryDelayMs(attemptNumber: number) {
  const exponent = Math.max(0, Math.min(10, attemptNumber - 1));
  return Math.min(EMAIL_RETRY_MAX_MS, EMAIL_RETRY_BASE_MS * (2 ** exponent));
}

export function normalizeEmailDeliveryError(error: unknown): NormalizedEmailDeliveryError {
  if (error instanceof EmailProviderRequestError) {
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
          attemptNumber,
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
        attemptNumber,
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
) {
  const attemptNumber = message.attemptCount + 1;
  const reschedule = error.retryable && attemptNumber < MAX_EMAIL_DELIVERY_ATTEMPTS;
  const availableAt = new Date(completedAt.getTime() + emailRetryDelayMs(attemptNumber));
  const finalized = await prisma.$transaction(async (tx) => {
    const updated = await tx.messageOutbox.updateMany({
      where: {
        id: message.id,
        status: "PROCESSING",
        lockToken: message.lockToken,
      },
      data: {
        status: reschedule ? "PENDING" : "FAILED",
        attemptCount: attemptNumber,
        availableAt: reschedule ? availableAt : completedAt,
        lockedAt: null,
        lockToken: null,
        failedAt: reschedule ? null : completedAt,
        provider: "RESEND",
        providerDeliveryStatus: reschedule ? undefined : "FAILED",
        providerStatusAt: reschedule ? undefined : completedAt,
        lastError: error.message,
      },
    });
    if (updated.count !== 1) return false;
    await tx.messageDeliveryAttempt.create({
      data: {
        messageOutboxId: message.id,
        attemptNumber,
        provider: "RESEND",
        status: "FAILED",
        errorCode: error.code,
        errorMessage: error.message,
        providerMetadata: {
          retryable: error.retryable,
          rescheduled: reschedule,
          ...(reschedule ? { nextAvailableAt: availableAt.toISOString() } : {}),
          idempotencyKey: `outbox:${message.id}`,
          realDelivery: true,
        },
        startedAt: message.startedAt,
        completedAt,
      },
    });
    return true;
  });
  return { finalized, rescheduled: finalized && reschedule };
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
        bodyHtml: preparedBody.bodyHtml
          ? renderEmailHtmlDocument({
            title: message.subjectSnapshot,
            bodyHtml: preparedBody.bodyHtml,
            footer: message.senderNameSnapshot,
          })
          : null,
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
      else if (failure.finalized) result.failedIds.push(message.id);
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
