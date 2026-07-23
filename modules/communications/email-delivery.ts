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
import { REGISTRATION_MANAGE_LINK_SENTINEL } from "@/modules/communications/manage-link";
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
  prepareBodyText?: typeof prepareEmailBodyForDelivery;
};

export type ExternalEmailQueueResult = {
  recoveredIds: string[];
  sentIds: string[];
  failedIds: string[];
  rescheduledIds: string[];
};

type ClaimedMessage = {
  id: string;
  eventId: string;
  registrationId: string | null;
  recipientEmail: string;
  senderNameSnapshot: string;
  senderEmailSnapshot: string | null;
  replyToEmailSnapshot: string | null;
  subjectSnapshot: string;
  bodyTextSnapshot: string;
  attemptCount: number;
  lockToken: string;
  startedAt: Date;
};

export type PreparedEmailBody = {
  bodyText: string;
  revokeOnDefinitiveFailure?: () => Promise<void>;
};

export async function prepareEmailBodyForDelivery(input: {
  messageId: string;
  registrationId: string | null;
  bodyText: string;
  now: Date;
}): Promise<PreparedEmailBody> {
  if (!input.bodyText.includes(REGISTRATION_MANAGE_LINK_SENTINEL)) {
    return { bodyText: input.bodyText };
  }
  if (!input.registrationId) {
    throw new Error(
      "A registration message cannot insert a private link without a registration.",
    );
  }

  const appBaseUrl = getServerEnv().APP_BASE_URL;
  const access = await createStableRegistrationAccessToken({
    registrationId: input.registrationId,
    deliveryKey: `message:${input.messageId}`,
    now: input.now,
  });
  const manageUrl = new URL(access.managePath, appBaseUrl).toString();
  return {
    bodyText: input.bodyText.replaceAll(
      REGISTRATION_MANAGE_LINK_SENTINEL,
      manageUrl,
    ),
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
      | "EXTERNAL_EMAIL_NOT_CONFIGURED",
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
        error.message,
      );
    }
    throw error;
  }
}

async function recoverStaleClaims(
  prisma: DeliveryPrisma,
  eventId: string,
  messageIds: string[] | undefined,
  now: Date,
) {
  const staleBefore = new Date(now.getTime() - EMAIL_DELIVERY_LOCK_TIMEOUT_MS);
  const candidates = await prisma.messageOutbox.findMany({
    where: {
      eventId,
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
  eventId: string,
  messageIds: string[] | undefined,
  now: Date,
): Promise<ClaimedMessage | null> {
  for (let collision = 0; collision < 5; collision += 1) {
    const lockToken = randomUUID();
    const claimed = await prisma.$transaction(async (tx) => {
      const message = await tx.messageOutbox.findFirst({
        where: {
          eventId,
          status: "PENDING",
          availableAt: { lte: now },
          attemptCount: { lt: MAX_EMAIL_DELIVERY_ATTEMPTS },
          ...(messageIds ? { id: { in: messageIds } } : {}),
        },
        orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          eventId: true,
          registrationId: true,
          recipientEmail: true,
          senderNameSnapshot: true,
          senderEmailSnapshot: true,
          replyToEmailSnapshot: true,
          subjectSnapshot: true,
          bodyTextSnapshot: true,
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

export async function processExternalEmailQueue(
  eventId: string,
  options: {
    messageIds?: string[];
    limit?: number;
    dependencies?: ExternalEmailDeliveryDependencies;
  } = {},
): Promise<ExternalEmailQueueResult> {
  const dependencies = options.dependencies ?? {};
  const prisma = resolvePrisma(dependencies);
  const settings = await prisma.eventMessageSettings.findUnique({
    where: { eventId },
    select: { deliveryMode: true, senderEmail: true },
  });
  if (settings?.deliveryMode !== "EXTERNAL_EMAIL") {
    throw new ExternalEmailDeliveryError(
      "EXTERNAL_EMAIL_NOT_ENABLED",
      "Real email delivery is not enabled for this event.",
    );
  }
  if (!settings.senderEmail?.trim()) {
    throw new ExternalEmailDeliveryError(
      "EXTERNAL_EMAIL_NOT_CONFIGURED",
      "Add a verified sender email before sending real email.",
    );
  }
  const configuration = resolveConfiguration(dependencies);
  const sendEmail = dependencies.sendEmail ?? sendEmailWithResend;
  const now = dependencies.now ?? (() => new Date());
  const uniqueMessageIds = options.messageIds
    ? [...new Set(options.messageIds)]
    : undefined;
  const limit = Math.max(
    1,
    Math.min(EMAIL_DELIVERY_BATCH_SIZE, options.limit ?? EMAIL_DELIVERY_BATCH_SIZE),
  );

  const recoveredIds = await recoverStaleClaims(
    prisma,
    eventId,
    uniqueMessageIds,
    now(),
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
      eventId,
      uniqueMessageIds,
      now(),
    );
    if (!message) break;
    let preparedBody: PreparedEmailBody | null = null;
    try {
      const prepareBodyText = dependencies.prepareBodyText
        ?? prepareEmailBodyForDelivery;
      preparedBody = await prepareBodyText({
        messageId: message.id,
        registrationId: message.registrationId,
        bodyText: message.bodyTextSnapshot,
        now: message.startedAt,
      });
      const delivery = await sendEmail({
        fromName: message.senderNameSnapshot,
        fromEmail: message.senderEmailSnapshot ?? "",
        toEmail: message.recipientEmail,
        replyToEmail: message.replyToEmailSnapshot,
        subject: message.subjectSnapshot,
        bodyText: preparedBody.bodyText,
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
          console.error(
            "Unable to revoke an unused private registration link after a definitive email failure.",
            revokeError instanceof Error ? revokeError.name : "UnknownError",
          );
        }
      }
      const failure = await finalizeFailedAttempt(
        prisma,
        message,
        normalized,
        now(),
      );
      if (failure.rescheduled) result.rescheduledIds.push(message.id);
      else if (failure.finalized) result.failedIds.push(message.id);
    }
  }
  return result;
}
