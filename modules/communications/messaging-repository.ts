import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  MessageOutboxStatus,
  MessageProviderDeliveryStatus,
  MessageRecipientKind,
  MessageTemplateKey as PrismaMessageTemplateKey,
  MessageTemplateStatus,
  Prisma,
} from "@prisma/client";
import {
  getResendEmailAvailability,
} from "@/integrations/email/resend";
import { getPrisma } from "@/lib/prisma";
import {
  ExternalEmailDeliveryError,
  processExternalEmailQueue,
  type ExternalEmailDeliveryDependencies,
} from "@/modules/communications/email-delivery";
import type {
  BalanceReminderBatchInput,
  ConfirmationResendInput,
  MessageRetryInput,
  MessagingSettingsInput,
  MessageTemplateInput,
  MessageTestInput,
} from "@/modules/communications/schemas";
import {
  messageRetryIdempotencyKey,
  messageRetryRequestFingerprint,
} from "@/modules/communications/message-retry-domain";
import {
  DEFAULT_MESSAGE_TEMPLATE_LIST,
  DEFAULT_MESSAGE_TEMPLATES,
  MESSAGE_TEMPLATE_KEYS,
  SAMPLE_MESSAGE_TEMPLATE_CONTEXT,
  formatMessageDateRange,
  formatMessageMoney,
  renderMessageTemplate,
  selectRegistrationMessageTemplate,
  type MessageTemplateContext,
  type MessageTemplateKey,
} from "@/modules/communications/templates";
import {
  computeBalanceReminderPreview,
  type BalanceReminderCandidate,
  type BalanceReminderPreviewContext,
} from "@/modules/communications/reminder-audience";
import type {
  BalanceReminderPreview,
  MessageOutboxRecord,
  MessageOutboxStatusValue,
  MessageTemplateRecord,
  MessagingWorkspaceData,
} from "@/modules/communications/types";
import { REGISTRATION_MANAGE_LINK_SENTINEL } from "@/modules/communications/manage-link";
import type { FormCalculation, RegistrationFormDefinition } from "@/modules/forms/definition";

const fallbackSettings = {
  deliveryMode: "LOCAL_CAPTURE" as const,
  senderName: "IMSDA Events",
  senderEmail: null,
  replyToEmail: null,
  internalNotificationEmails: [] as string[],
};

const outboxStatuses: MessageOutboxStatusValue[] = [
  "PENDING",
  "PROCESSING",
  "CAPTURED",
  "SENT",
  "FAILED",
  "SUPPRESSED",
  "CANCELLED",
];

type EventMessageIdentity = {
  firstName: string;
  lastName: string;
  email: string;
};

export type RegistrationMessageInput = {
  event: {
    id: string;
    name: string;
    slug: string;
    startsAt: Date;
    endsAt: Date;
    timezone: string;
    location: string | null;
  };
  registration: {
    id: string;
    confirmationCode: string;
    attendeeType: string;
  };
  formVersionId: string;
  submissionIdempotencyKey: string;
  identity: EventMessageIdentity;
  definition: RegistrationFormDefinition;
  responses: Record<string, unknown>;
  attendeeResponses?: Array<Record<string, unknown>>;
  calculation: FormCalculation;
};

export type QueuedRegistrationMessages = {
  messageIds: string[];
  registrantMessageIds: string[];
  pendingMessageIds: string[];
  deliveryMode: "DISABLED" | "LOCAL_CAPTURE" | "EXTERNAL_EMAIL";
};

export class MessagingError extends Error {
  constructor(
    public readonly code:
      | "MESSAGE_NOT_FOUND"
      | "TEMPLATE_NOT_FOUND"
      | "DELIVERY_DISABLED"
      | "EXTERNAL_EMAIL_NOT_CONFIGURED"
      | "MESSAGE_NOT_RETRYABLE"
      | "MESSAGE_NOT_RESENDABLE"
      | "PREVIEW_CHANGED"
      | "EMPTY_AUDIENCE"
      | "IDEMPOTENCY_KEY_REUSED"
      | "INVALID_TEMPLATE",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MessagingError";
  }
}

function stringArrayFromJson(value: Prisma.JsonValue | null | undefined) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => zodlessEmailCheck(entry)))];
}

function zodlessEmailCheck(value: string) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function recordFromJson(value: Prisma.JsonValue | null | undefined) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, Prisma.JsonValue>
    : {};
}

function moneyToCents(value: { toString(): string } | number) {
  return Math.round(Number(value) * 100);
}

function summaryValue(value: unknown) {
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  return "";
}

function registrationSummary(
  _definition: RegistrationFormDefinition,
  _responses: Record<string, unknown>,
  identity: EventMessageIdentity,
  attendeeResponses: Array<Record<string, unknown>> = [],
) {
  const lines = [`Primary contact: ${identity.firstName} ${identity.lastName}`.trim()];
  attendeeResponses.forEach((attendee, index) => {
    const firstName = summaryValue(attendee.first_name);
    const lastName = summaryValue(attendee.last_name);
    const fullName = `${firstName} ${lastName}`.trim()
      || summaryValue(attendee.full_name)
      || summaryValue(attendee.name)
      || summaryValue(attendee.attendee_name)
      || summaryValue(attendee.guest_name)
      || (attendeeResponses.length === 1
        ? `${identity.firstName} ${identity.lastName}`.trim()
        : `Attendee ${index + 1}`);
    lines.push(`${index + 1}. ${fullName}`);
  });
  return lines.join("\n");
}

function messageDedupeKey(
  formVersionId: string,
  submissionIdempotencyKey: string,
  templateKey: MessageTemplateKey,
  recipientEmail: string,
) {
  const digest = createHash("sha256")
    .update([formVersionId, submissionIdempotencyKey, templateKey, recipientEmail].join("\u0000"))
    .digest("hex");
  return `public-registration:${digest}`;
}

function settingsRecord(settings: {
  deliveryMode: "DISABLED" | "LOCAL_CAPTURE" | "EXTERNAL_EMAIL";
  senderName: string;
  senderEmail: string | null;
  replyToEmail: string | null;
  internalNotificationEmails: Prisma.JsonValue;
}) {
  const availability = getResendEmailAvailability();
  return {
    deliveryMode: settings.deliveryMode,
    senderName: settings.senderName,
    senderEmail: settings.senderEmail ?? "",
    replyToEmail: settings.replyToEmail ?? "",
    internalNotificationEmails: stringArrayFromJson(settings.internalNotificationEmails),
    providerConfigured: availability.deliveryConfigured,
    webhookConfigured: availability.webhookConfigured,
  };
}

function serializeTemplate(
  template: {
    id: string;
    key: PrismaMessageTemplateKey;
    isEnabled: boolean;
    versions: Array<{
      id: string;
      versionNumber: number;
      status: MessageTemplateStatus;
      subjectTemplate: string;
      bodyTemplate: string;
      publishedAt: Date | null;
      createdAt: Date;
      createdBy: { displayName: string } | null;
    }>;
  },
): MessageTemplateRecord {
  const versions = template.versions.map((version) => ({
    id: version.id,
    versionNumber: version.versionNumber,
    status: version.status,
    subjectTemplate: version.subjectTemplate,
    bodyTemplate: version.bodyTemplate,
    publishedAt: version.publishedAt?.toISOString() ?? null,
    createdAt: version.createdAt.toISOString(),
    createdBy: version.createdBy?.displayName ?? null,
  }));
  const definition = DEFAULT_MESSAGE_TEMPLATES[template.key];
  return {
    id: template.id,
    key: template.key,
    name: definition.name,
    description: definition.description,
    isEnabled: template.isEnabled,
    activeVersion: versions.find((version) => version.status === "PUBLISHED") ?? null,
    versions,
  };
}

function serializeMessage(message: {
  id: string;
  eventId: string;
  registrationId: string | null;
  templateVersionId: string | null;
  templateKey: PrismaMessageTemplateKey;
  recipientKind: MessageRecipientKind;
  recipientEmail: string;
  recipientName: string | null;
  senderNameSnapshot: string;
  senderEmailSnapshot: string | null;
  replyToEmailSnapshot: string | null;
  subjectSnapshot: string;
  bodyTextSnapshot: string;
  status: MessageOutboxStatus;
  attemptCount: number;
  capturedAt: Date | null;
  sentAt: Date | null;
  provider: string | null;
  providerMessageId: string | null;
  providerDeliveryStatus: MessageProviderDeliveryStatus | null;
  providerStatusAt: Date | null;
  deliveredAt: Date | null;
  failedAt: Date | null;
  lastError: string | null;
  retryOfMessageId: string | null;
  createdAt: Date;
  registration: { id: string; confirmationCode: string } | null;
  templateVersion: { id: string; versionNumber: number } | null;
  attempts: Array<{
    id: string;
    attemptNumber: number;
    provider: string;
    status: "CAPTURED" | "SENT" | "FAILED";
    providerMessageId: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    startedAt: Date;
    completedAt: Date | null;
  }>;
}, deliveryMode: "DISABLED" | "LOCAL_CAPTURE" | "EXTERNAL_EMAIL"): MessageOutboxRecord {
  return {
    id: message.id,
    templateKey: message.templateKey,
    recipientKind: message.recipientKind,
    recipientEmail: message.recipientEmail,
    recipientName: message.recipientName,
    senderName: message.senderNameSnapshot,
    senderEmail: message.senderEmailSnapshot,
    replyToEmail: message.replyToEmailSnapshot,
    subject: message.subjectSnapshot,
    bodyText: message.bodyTextSnapshot,
    status: message.status,
    attemptCount: message.attemptCount,
    capturedAt: message.capturedAt?.toISOString() ?? null,
    sentAt: message.sentAt?.toISOString() ?? null,
    provider: message.provider,
    providerMessageId: message.providerMessageId,
    providerDeliveryStatus: message.providerDeliveryStatus,
    providerStatusAt: message.providerStatusAt?.toISOString() ?? null,
    deliveredAt: message.deliveredAt?.toISOString() ?? null,
    failedAt: message.failedAt?.toISOString() ?? null,
    lastError: message.lastError,
    retryOfMessageId: message.retryOfMessageId,
    retryRequestFingerprint: messageRetryRequestFingerprint({
      eventId: message.eventId,
      sourceMessageId: message.id,
      deliveryMode,
      registrationId: message.registrationId,
      templateVersionId: message.templateVersionId,
      templateKey: message.templateKey,
      recipientKind: message.recipientKind,
      recipientEmail: message.recipientEmail,
      recipientName: message.recipientName,
      senderNameSnapshot: message.senderNameSnapshot,
      senderEmailSnapshot: message.senderEmailSnapshot,
      replyToEmailSnapshot: message.replyToEmailSnapshot,
      subjectSnapshot: message.subjectSnapshot,
      bodyTextSnapshot: message.bodyTextSnapshot,
    }),
    createdAt: message.createdAt.toISOString(),
    registration: message.registration,
    templateVersion: message.templateVersion,
    attempts: message.attempts.map((attempt) => ({
      ...attempt,
      startedAt: attempt.startedAt.toISOString(),
      completedAt: attempt.completedAt?.toISOString() ?? null,
    })),
  };
}

export async function ensureEventMessagingDefaults(eventId: string) {
  const prisma = getPrisma();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.eventMessageSettings.upsert({
          where: { eventId },
          update: {},
          create: {
            eventId,
            senderName: fallbackSettings.senderName,
            deliveryMode: fallbackSettings.deliveryMode,
            internalNotificationEmails: [],
          },
        });

        for (const definition of DEFAULT_MESSAGE_TEMPLATE_LIST) {
          const template = await tx.eventMessageTemplate.upsert({
            where: {
              eventId_key: {
                eventId,
                key: definition.key,
              },
            },
            update: {},
            create: {
              eventId,
              key: definition.key,
              isEnabled: true,
            },
            select: {
              id: true,
              versions: { select: { id: true }, take: 1 },
            },
          });
          if (template.versions.length === 0) {
            await tx.messageTemplateVersion.create({
              data: {
                templateId: template.id,
                versionNumber: 1,
                status: "PUBLISHED",
                subjectTemplate: definition.subject,
                bodyTemplate: definition.body,
                publishedAt: new Date(),
              },
            });
          }
        }
      });
      return;
    } catch (error) {
      const retryable = error instanceof Prisma.PrismaClientKnownRequestError
        && (error.code === "P2002" || error.code === "P2034");
      if (!retryable || attempt === 2) throw error;
    }
  }
}

type MessagingDatabaseClient = Prisma.TransactionClient | ReturnType<typeof getPrisma>;

async function loadBalanceReminderState(
  eventId: string,
  client: MessagingDatabaseClient,
  now = new Date(),
) {
  const [event, settingsRow, template, registrations] = await Promise.all([
    client.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        name: true,
        startsAt: true,
        endsAt: true,
        timezone: true,
        location: true,
        supportContact: true,
      },
    }),
    client.eventMessageSettings.findUnique({ where: { eventId } }),
    client.eventMessageTemplate.findUnique({
      where: {
        eventId_key: {
          eventId,
          key: "BALANCE_REMINDER",
        },
      },
      include: {
        versions: {
          where: { status: "PUBLISHED" },
          orderBy: { versionNumber: "desc" },
          take: 1,
        },
      },
    }),
    client.registration.findMany({
      where: { eventId },
      orderBy: { id: "asc" },
      select: {
        id: true,
        confirmationCode: true,
        status: true,
        totalAmount: true,
        contactSnapshot: true,
        accountHolderPerson: {
          select: {
            firstName: true,
            lastName: true,
            normalizedEmail: true,
          },
        },
        payments: {
          where: { status: "SUCCEEDED" },
          select: {
            amount: true,
            refunds: {
              where: { status: "SUCCEEDED" },
              select: { amount: true },
            },
          },
        },
      },
    }),
  ]);

  if (!event) {
    throw new MessagingError(
      "MESSAGE_NOT_FOUND",
      "That event is no longer available.",
    );
  }

  const settings = settingsRow ?? fallbackSettings;
  const version = template?.versions[0] ?? null;
  const candidates: BalanceReminderCandidate[] = registrations.map((registration) => {
    const contact = recordFromJson(registration.contactSnapshot);
    const contactValue = (
      key: "firstName" | "lastName" | "email",
      fallback: string,
    ) => typeof contact[key] === "string" ? contact[key].trim() : fallback;
    const firstName = contactValue(
      "firstName",
      registration.accountHolderPerson.firstName,
    );
    const lastName = contactValue(
      "lastName",
      registration.accountHolderPerson.lastName,
    );
    const netPaidCents = registration.payments.reduce((paymentTotal, payment) => {
      const refundedCents = payment.refunds.reduce(
        (refundTotal, refund) => refundTotal + moneyToCents(refund.amount),
        0,
      );
      return paymentTotal + moneyToCents(payment.amount) - refundedCents;
    }, 0);
    return {
      registrationId: registration.id,
      confirmationCode: registration.confirmationCode,
      status: registration.status,
      recipientName: `${firstName} ${lastName}`.trim(),
      recipientEmail: contactValue(
        "email",
        registration.accountHolderPerson.normalizedEmail ?? "",
      ),
      totalCents: moneyToCents(registration.totalAmount),
      netPaidCents,
    };
  });
  const context: BalanceReminderPreviewContext = {
    eventId,
    deliveryMode: settings.deliveryMode,
    senderName: settings.senderName,
    senderEmail: settings.senderEmail,
    // Fingerprint the exact fallback the renderer will use. Otherwise a
    // support-contact edit could change reviewed content without requiring a
    // fresh audience preview.
    replyToEmail: settings.replyToEmail
      || settings.senderEmail
      || event.supportContact
      || null,
    templateEnabled: template?.isEnabled ?? true,
    templateVersionId: version?.id ?? null,
    templateVersionNumber: version?.versionNumber ?? null,
    eventSnapshot: {
      name: event.name,
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
      timezone: event.timezone,
      location: event.location,
    },
  };
  return {
    event,
    settings,
    template,
    version,
    preview: computeBalanceReminderPreview(candidates, context, now),
  };
}

export async function getBalanceReminderPreview(
  eventId: string,
): Promise<BalanceReminderPreview> {
  await ensureEventMessagingDefaults(eventId);
  return (await loadBalanceReminderState(eventId, getPrisma())).preview;
}

export async function getMessagingWorkspace(eventId: string): Promise<MessagingWorkspaceData> {
  await ensureEventMessagingDefaults(eventId);
  const prisma = getPrisma();
  const [settings, templates, messages, groupedCounts, reminderState] = await Promise.all([
    prisma.eventMessageSettings.findUniqueOrThrow({ where: { eventId } }),
    prisma.eventMessageTemplate.findMany({
      where: { eventId },
      include: {
        versions: {
          orderBy: { versionNumber: "desc" },
          include: { createdBy: { select: { displayName: true } } },
        },
      },
    }),
    prisma.messageOutbox.findMany({
      where: { eventId },
      orderBy: { createdAt: "desc" },
      take: 150,
      include: {
        registration: { select: { id: true, confirmationCode: true } },
        templateVersion: { select: { id: true, versionNumber: true } },
        attempts: { orderBy: { attemptNumber: "desc" } },
      },
    }),
    prisma.messageOutbox.groupBy({
      by: ["status"],
      where: { eventId },
      _count: { _all: true },
    }),
    loadBalanceReminderState(eventId, prisma),
  ]);

  const counts = Object.fromEntries(outboxStatuses.map((status) => [status, 0])) as Record<MessageOutboxStatusValue, number>;
  for (const row of groupedCounts) counts[row.status] = row._count._all;
  const keyOrder = new Map(MESSAGE_TEMPLATE_KEYS.map((key, index) => [key, index]));

  return {
    settings: settingsRecord(settings),
    templates: templates
      .map(serializeTemplate)
      .sort((left, right) => (keyOrder.get(left.key) ?? 99) - (keyOrder.get(right.key) ?? 99)),
    messages: messages.map((message) => (
      serializeMessage(message, settings.deliveryMode)
    )),
    counts,
    reminderPreview: reminderState.preview,
  };
}

export async function updateMessagingSettings(
  eventId: string,
  input: MessagingSettingsInput,
  actorUserId: string,
) {
  if (
    input.deliveryMode === "EXTERNAL_EMAIL"
    && !getResendEmailAvailability().deliveryConfigured
  ) {
    throw new MessagingError(
      "EXTERNAL_EMAIL_NOT_CONFIGURED",
      "Add the Resend API key before enabling real email delivery.",
    );
  }
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    await tx.eventMessageSettings.upsert({
      where: { eventId },
      update: {
        deliveryMode: input.deliveryMode,
        senderName: input.senderName,
        senderEmail: input.senderEmail || null,
        replyToEmail: input.replyToEmail || null,
        internalNotificationEmails: input.internalNotificationEmails,
      },
      create: {
        eventId,
        deliveryMode: input.deliveryMode,
        senderName: input.senderName,
        senderEmail: input.senderEmail || null,
        replyToEmail: input.replyToEmail || null,
        internalNotificationEmails: input.internalNotificationEmails,
      },
    });
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: "MESSAGE_SETTINGS_UPDATED",
        entityType: "EventMessageSettings",
        entityId: eventId,
        correlationId: randomUUID(),
        summary: `Updated event message settings in ${input.deliveryMode.toLowerCase().replaceAll("_", " ")} mode.`,
        metadata: {
          internalRecipientCount: input.internalNotificationEmails.length,
          senderEmailConfigured: Boolean(input.senderEmail),
          replyToConfigured: Boolean(input.replyToEmail),
          providerConfigured: getResendEmailAvailability().deliveryConfigured,
          realDelivery: input.deliveryMode === "EXTERNAL_EMAIL",
        },
      },
    });
  });
  return getMessagingWorkspace(eventId);
}

export async function publishMessageTemplateVersion(
  eventId: string,
  templateId: string,
  input: MessageTemplateInput,
  actorUserId: string,
) {
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    const template = await tx.eventMessageTemplate.findFirst({
      where: { id: templateId, eventId },
      include: { versions: { select: { versionNumber: true } } },
    });
    if (!template) throw new MessagingError("TEMPLATE_NOT_FOUND", "That message template does not exist for this event.");
    const nextVersion = Math.max(0, ...template.versions.map((version) => version.versionNumber)) + 1;
    await tx.messageTemplateVersion.updateMany({
      where: { templateId, status: { in: ["DRAFT", "PUBLISHED"] } },
      data: { status: "ARCHIVED" },
    });
    const version = await tx.messageTemplateVersion.create({
      data: {
        templateId,
        createdByUserId: actorUserId,
        versionNumber: nextVersion,
        status: "PUBLISHED",
        subjectTemplate: input.subjectTemplate,
        bodyTemplate: input.bodyTemplate,
        publishedAt: new Date(),
      },
    });
    await tx.eventMessageTemplate.update({
      where: { id: templateId },
      data: { isEnabled: input.isEnabled },
    });
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: "MESSAGE_TEMPLATE_PUBLISHED",
        entityType: "MessageTemplateVersion",
        entityId: version.id,
        correlationId: randomUUID(),
        summary: `Published ${template.key.toLowerCase().replaceAll("_", " ")} message template version ${nextVersion}.`,
        metadata: { templateId, templateKey: template.key, versionNumber: nextVersion, isEnabled: input.isEnabled },
      },
    });
  });
  return getMessagingWorkspace(eventId);
}

async function captureOneMessageLocally(messageId: string, eventId?: string) {
  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    const message = await tx.messageOutbox.findFirst({
      where: { id: messageId, ...(eventId ? { eventId } : {}) },
      select: {
        id: true,
        eventId: true,
        status: true,
        attemptCount: true,
        event: { select: { messageSettings: { select: { deliveryMode: true } } } },
      },
    });
    if (!message || message.status !== "PENDING") return false;
    if (message.event.messageSettings?.deliveryMode === "DISABLED") return false;

    const lockToken = randomUUID();
    const claimed = await tx.messageOutbox.updateMany({
      where: { id: message.id, status: "PENDING", availableAt: { lte: new Date() } },
      data: { status: "PROCESSING", lockedAt: new Date(), lockToken },
    });
    if (claimed.count !== 1) return false;

    const completedAt = new Date();
    const attemptNumber = message.attemptCount + 1;
    await tx.messageDeliveryAttempt.create({
      data: {
        messageOutboxId: message.id,
        attemptNumber,
        provider: "LOCAL_CAPTURE",
        status: "CAPTURED",
        providerMessageId: `local:${message.id}:${attemptNumber}`,
        providerMetadata: { realDelivery: false },
        completedAt,
      },
    });
    await tx.messageOutbox.update({
      where: { id: message.id },
      data: {
        status: "CAPTURED",
        attemptCount: attemptNumber,
        capturedAt: completedAt,
        lockedAt: null,
        lockToken: null,
        lastError: null,
      },
    });
    return true;
  });
}

export async function captureMessageIdsLocally(messageIds: string[]) {
  const capturedIds: string[] = [];
  for (const messageId of [...new Set(messageIds)]) {
    if (await captureOneMessageLocally(messageId)) capturedIds.push(messageId);
  }
  return capturedIds;
}

export async function processPendingMessagesLocally(eventId: string, actorUserId: string) {
  const prisma = getPrisma();
  const settings = await prisma.eventMessageSettings.findUnique({ where: { eventId } });
  if (settings?.deliveryMode !== "LOCAL_CAPTURE") {
    throw new MessagingError(
      "DELIVERY_DISABLED",
      settings?.deliveryMode === "EXTERNAL_EMAIL"
        ? "This event is configured for real email. Use the delivery processor instead."
        : "Local message capture is disabled for this event.",
    );
  }
  const pending = await prisma.messageOutbox.findMany({
    where: { eventId, status: "PENDING", availableAt: { lte: new Date() } },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: { id: true },
  });
  const capturedIds: string[] = [];
  for (const message of pending) {
    if (await captureOneMessageLocally(message.id, eventId)) capturedIds.push(message.id);
  }
  if (capturedIds.length > 0) {
    await prisma.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: "MESSAGE_QUEUE_CAPTURED_LOCALLY",
        entityType: "MessageOutbox",
        correlationId: randomUUID(),
        summary: `Captured ${capturedIds.length} queued message${capturedIds.length === 1 ? "" : "s"} locally without external delivery.`,
        metadata: { messageIds: capturedIds, realDelivery: false },
      },
    });
  }
  return getMessagingWorkspace(eventId);
}

function asMessagingDeliveryError(error: unknown): never {
  if (error instanceof ExternalEmailDeliveryError) {
    throw new MessagingError(
      error.code === "EXTERNAL_EMAIL_NOT_CONFIGURED"
        ? "EXTERNAL_EMAIL_NOT_CONFIGURED"
        : "DELIVERY_DISABLED",
      error.message,
    );
  }
  throw error;
}

export async function processPendingMessages(
  eventId: string,
  actorUserId: string,
  dependencies?: ExternalEmailDeliveryDependencies,
) {
  await ensureEventMessagingDefaults(eventId);
  const prisma = getPrisma();
  const settings = await prisma.eventMessageSettings.findUniqueOrThrow({
    where: { eventId },
    select: { deliveryMode: true },
  });
  if (settings.deliveryMode === "DISABLED") {
    throw new MessagingError(
      "DELIVERY_DISABLED",
      "Message delivery is turned off for this event.",
    );
  }
  if (settings.deliveryMode === "LOCAL_CAPTURE") {
    return processPendingMessagesLocally(eventId, actorUserId);
  }

  let result;
  try {
    result = await processExternalEmailQueue(eventId, { dependencies });
  } catch (error) {
    asMessagingDeliveryError(error);
  }
  const processedCount = result.sentIds.length
    + result.failedIds.length
    + result.rescheduledIds.length;
  if (processedCount > 0 || result.recoveredIds.length > 0) {
    await prisma.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: "MESSAGE_QUEUE_PROCESSED_EXTERNALLY",
        entityType: "MessageOutbox",
        correlationId: randomUUID(),
        summary: `Processed ${processedCount} queued email${processedCount === 1 ? "" : "s"} through Resend.`,
        metadata: {
          sentMessageIds: result.sentIds,
          failedMessageIds: result.failedIds,
          rescheduledMessageIds: result.rescheduledIds,
          recoveredStaleMessageIds: result.recoveredIds,
          realDelivery: true,
        },
      },
    });
  }
  return getMessagingWorkspace(eventId);
}

export async function createLocalTestMessage(
  eventId: string,
  templateId: string,
  input: MessageTestInput,
  actorUserId: string,
) {
  await ensureEventMessagingDefaults(eventId);
  const prisma = getPrisma();
  const [event, settings, template] = await Promise.all([
    prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, name: true, startsAt: true, endsAt: true, timezone: true, location: true },
    }),
    prisma.eventMessageSettings.findUnique({ where: { eventId } }),
    prisma.eventMessageTemplate.findFirst({
      where: { id: templateId, eventId },
      include: {
        versions: {
          where: { status: "PUBLISHED" },
          orderBy: { versionNumber: "desc" },
          take: 1,
        },
      },
    }),
  ]);
  const version = template?.versions[0];
  if (!event || !settings || !template || !version) {
    throw new MessagingError("TEMPLATE_NOT_FOUND", "That published message template is not available.");
  }
  if (settings.deliveryMode === "DISABLED") {
    throw new MessagingError("DELIVERY_DISABLED", "Turn on local capture before creating a test message.");
  }

  const context: MessageTemplateContext = {
    ...SAMPLE_MESSAGE_TEMPLATE_CONTEXT,
    recipient_name: input.recipientName,
    event_name: event.name,
    event_dates: formatMessageDateRange(event.startsAt, event.endsAt, { timeZone: event.timezone }),
    event_location: event.location || "Location to be announced",
    reply_to_email: settings.replyToEmail || settings.senderEmail || "the IMSDA event office",
  };
  const rendered = renderMessageTemplate(
    { subject: version.subjectTemplate, body: version.bodyTemplate },
    context,
  );
  if (!rendered.isComplete) {
    throw new MessagingError("INVALID_TEMPLATE", `The template could not be rendered: ${rendered.unresolvedTokens.join(", ")}.`);
  }
  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.messageOutbox.create({
      data: {
        eventId,
        templateVersionId: version.id,
        templateKey: template.key,
        recipientKind: "TEST",
        recipientEmail: input.recipientEmail,
        recipientName: input.recipientName,
        senderNameSnapshot: settings.senderName,
        senderEmailSnapshot: settings.senderEmail,
        replyToEmailSnapshot: settings.replyToEmail,
        subjectSnapshot: rendered.subject,
        bodyTextSnapshot: rendered.body,
        metadata: { trigger: "LOCAL_TEST", realDelivery: false },
        idempotencyKey: `local-test:${randomUUID()}`,
        correlationId: randomUUID(),
      },
    });
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: "MESSAGE_TEST_CREATED",
        entityType: "MessageOutbox",
        entityId: created.id,
        correlationId: created.correlationId,
        summary: `Created a local test capture for ${input.recipientEmail}.`,
        metadata: { templateId, templateVersionId: version.id, realDelivery: false },
      },
    });
    return created;
  });
  await captureOneMessageLocally(message.id, eventId);
  return getMessagingWorkspace(eventId);
}

export type BalanceReminderBatchOperation = {
  batchId: string;
  messageIds: string[];
  includedCount: number;
  totalBalanceCents: number;
  deliveryMode: "DISABLED" | "LOCAL_CAPTURE" | "EXTERNAL_EMAIL";
  queuedCount: number;
  capturedCount: number;
  suppressedCount: number;
  replayed: boolean;
};

export async function enqueueBalanceReminderBatch(
  eventId: string,
  input: BalanceReminderBatchInput,
  actorUserId: string,
): Promise<BalanceReminderBatchOperation> {
  await ensureEventMessagingDefaults(eventId);
  const prisma = getPrisma();
  let transactionResult:
    | (Omit<BalanceReminderBatchOperation, "capturedCount"> & {
      existingCapturedCount: number;
    })
    | undefined;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      transactionResult = await prisma.$transaction(async (tx) => {
        const operationEntityId = `balance-reminder:${eventId}:${input.batchId}`;
        const existingAudit = await tx.auditLog.findFirst({
          where: {
            eventId,
            action: "BALANCE_REMINDER_BATCH_ENQUEUED",
            entityId: operationEntityId,
          },
          select: { metadata: true },
        });
        if (existingAudit) {
          const metadata = recordFromJson(existingAudit.metadata);
          const storedFingerprint = typeof metadata.previewFingerprint === "string"
            ? metadata.previewFingerprint
            : "";
          if (storedFingerprint !== input.previewFingerprint) {
            throw new MessagingError(
              "IDEMPOTENCY_KEY_REUSED",
              "This batch ID was already used with a different preview. Refresh the page and create a new batch.",
            );
          }
          const existingMessages = await tx.messageOutbox.findMany({
            where: {
              eventId,
              templateKey: "BALANCE_REMINDER",
              correlationId: input.batchId,
            },
            orderBy: { createdAt: "asc" },
            select: { id: true, status: true },
          });
          const storedMode = metadata.deliveryMode;
          const deliveryMode = storedMode === "DISABLED"
            || storedMode === "LOCAL_CAPTURE"
            || storedMode === "EXTERNAL_EMAIL"
            ? storedMode
            : "LOCAL_CAPTURE";
          const initialQueuedCount = typeof metadata.initialQueuedCount === "number"
            ? metadata.initialQueuedCount
            : existingMessages.filter((message) => message.status !== "SUPPRESSED").length;
          const currentCapturedCount = existingMessages.filter(
            (message) => message.status === "CAPTURED",
          ).length;
          return {
            batchId: input.batchId,
            messageIds: existingMessages.map((message) => message.id),
            includedCount: typeof metadata.includedCount === "number"
              ? metadata.includedCount
              : existingMessages.length,
            totalBalanceCents: typeof metadata.totalBalanceCents === "number"
              ? metadata.totalBalanceCents
              : 0,
            deliveryMode,
            queuedCount: deliveryMode === "EXTERNAL_EMAIL"
              ? initialQueuedCount
              : existingMessages.filter(
                (message) => message.status === "PENDING"
                  || message.status === "PROCESSING",
              ).length,
            suppressedCount: typeof metadata.initialSuppressedCount === "number"
              ? metadata.initialSuppressedCount
              : existingMessages.filter((message) => message.status === "SUPPRESSED").length,
            replayed: true,
            existingCapturedCount: currentCapturedCount,
          };
        }

        const state = await loadBalanceReminderState(eventId, tx);
        if (state.preview.fingerprint !== input.previewFingerprint) {
          throw new MessagingError(
            "PREVIEW_CHANGED",
            "The reminder audience changed. Review the updated preview before creating the batch.",
            { reminderPreview: state.preview },
          );
        }
        if (state.preview.includedCount === 0) {
          throw new MessagingError(
            "EMPTY_AUDIENCE",
            "No active registrations currently have both a balance due and a valid contact email.",
            { reminderPreview: state.preview },
          );
        }

        const source = {
          isEnabled: state.template?.isEnabled ?? true,
          templateVersionId: state.version?.id ?? null,
          subject: state.version?.subjectTemplate
            ?? DEFAULT_MESSAGE_TEMPLATES.BALANCE_REMINDER.subject,
          body: state.version?.bodyTemplate
            ?? DEFAULT_MESSAGE_TEMPLATES.BALANCE_REMINDER.body,
        };
        const suppressed = state.settings.deliveryMode === "DISABLED"
          || !source.isEnabled;
        const correlationId = input.batchId;
        const messageIds: string[] = [];
        let queuedCount = 0;
        let suppressedCount = 0;

        for (const recipient of state.preview.recipients) {
          const rendered = renderMessageTemplate(
            { subject: source.subject, body: source.body },
            {
              recipient_name: recipient.recipientName,
              registrant_name: recipient.recipientName,
              event_name: state.event.name,
              event_dates: formatMessageDateRange(
                state.event.startsAt,
                state.event.endsAt,
                { timeZone: state.event.timezone },
              ),
              event_location: state.event.location || "Location to be announced",
              confirmation_code: recipient.confirmationCode,
              total_amount: formatMessageMoney(recipient.totalCents),
              balance_amount: formatMessageMoney(recipient.balanceCents),
              portal_url: REGISTRATION_MANAGE_LINK_SENTINEL,
              reply_to_email: state.settings.replyToEmail
                || state.settings.senderEmail
                || state.event.supportContact
                || "the IMSDA event office",
            },
          );
          if (!rendered.isComplete) {
            throw new MessagingError(
              "INVALID_TEMPLATE",
              `The balance reminder template has unresolved tokens: ${rendered.unresolvedTokens.join(", ")}.`,
            );
          }
          const message = await tx.messageOutbox.upsert({
            where: {
              idempotencyKey: `balance-reminder:${eventId}:${input.batchId}:${recipient.registrationId}`,
            },
            update: {},
            create: {
              eventId,
              registrationId: recipient.registrationId,
              templateVersionId: source.templateVersionId,
              templateKey: "BALANCE_REMINDER",
              recipientKind: "REGISTRANT",
              recipientEmail: recipient.recipientEmail,
              recipientName: recipient.recipientName,
              senderNameSnapshot: state.settings.senderName,
              senderEmailSnapshot: state.settings.senderEmail,
              replyToEmailSnapshot: state.settings.replyToEmail,
              subjectSnapshot: rendered.subject,
              bodyTextSnapshot: rendered.body,
              metadata: {
                trigger: "STAFF_BALANCE_REMINDER_BATCH",
                batchId: input.batchId,
                previewFingerprint: input.previewFingerprint,
                confirmationCode: recipient.confirmationCode,
                totalCents: recipient.totalCents,
                balanceCents: recipient.balanceCents,
                deliveryMode: state.settings.deliveryMode,
                realDelivery: state.settings.deliveryMode === "EXTERNAL_EMAIL",
              },
              idempotencyKey: `balance-reminder:${eventId}:${input.batchId}:${recipient.registrationId}`,
              correlationId,
              status: suppressed ? "SUPPRESSED" : "PENDING",
              lastError: suppressed
                ? state.settings.deliveryMode === "DISABLED"
                  ? "Delivery is disabled for this event."
                  : "The balance reminder template is disabled."
                : null,
            },
            select: { id: true, status: true },
          });
          messageIds.push(message.id);
          if (message.status === "PENDING") queuedCount += 1;
          if (message.status === "SUPPRESSED") suppressedCount += 1;
        }

        const audit = await tx.auditLog.createMany({
          data: [{
            eventId,
            actorUserId,
            action: "BALANCE_REMINDER_BATCH_ENQUEUED",
            entityType: "MessageBatch",
            entityId: `balance-reminder:${eventId}:${input.batchId}`,
            correlationId,
            summary: suppressed
              ? `Recorded a suppressed balance-reminder batch for ${state.preview.includedCount} registration${state.preview.includedCount === 1 ? "" : "s"}; no email was sent.`
              : state.settings.deliveryMode === "LOCAL_CAPTURE"
                ? `Created a local balance-reminder batch for ${state.preview.includedCount} registration${state.preview.includedCount === 1 ? "" : "s"}; no email was sent.`
                : `Queued a balance-reminder batch for ${state.preview.includedCount} registration${state.preview.includedCount === 1 ? "" : "s"} for later explicit email processing.`,
            metadata: {
              batchId: input.batchId,
              previewFingerprint: input.previewFingerprint,
              includedCount: state.preview.includedCount,
              skippedCount: state.preview.skippedCount,
              totalBalanceCents: state.preview.totalBalanceCents,
              deliveryMode: state.settings.deliveryMode,
              templateEnabled: source.isEnabled,
              templateVersionId: source.templateVersionId,
              initialQueuedCount: queuedCount,
              initialSuppressedCount: suppressedCount,
              realDelivery: false,
            },
          }],
          skipDuplicates: true,
        });

        return {
          batchId: input.batchId,
          messageIds,
          includedCount: state.preview.includedCount,
          totalBalanceCents: state.preview.totalBalanceCents,
          deliveryMode: state.settings.deliveryMode,
          queuedCount,
          suppressedCount,
          replayed: audit.count === 0,
          existingCapturedCount: 0,
        };
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
      break;
    } catch (error) {
      const retryable = error instanceof Prisma.PrismaClientKnownRequestError
        && error.code === "P2034";
      if (!retryable || attempt === 2) throw error;
    }
  }

  if (!transactionResult) {
    throw new Error("The reminder batch transaction did not complete.");
  }

  const capturedIds = transactionResult.deliveryMode === "LOCAL_CAPTURE"
    ? await captureMessageIdsLocally(transactionResult.messageIds)
    : [];
  const { existingCapturedCount, ...operation } = transactionResult;
  return {
    ...operation,
    queuedCount: Math.max(transactionResult.queuedCount - capturedIds.length, 0),
    capturedCount: existingCapturedCount + capturedIds.length,
  };
}

const registrationConfirmationTemplateKeys = new Set<PrismaMessageTemplateKey>([
  "REGISTRATION_CONFIRMATION_PAID",
  "REGISTRATION_CONFIRMATION_UNPAID",
  "WORKER_CONFIRMATION",
]);

export type ConfirmationResendOperation = {
  sourceMessageId: string;
  messageId: string;
  recipientEmail: string;
  deliveryMode: "DISABLED" | "LOCAL_CAPTURE" | "EXTERNAL_EMAIL";
  status: MessageOutboxStatusValue;
  destinationChanged: boolean;
  replayed: boolean;
};

export async function resendRegistrationConfirmation(
  eventId: string,
  sourceMessageId: string,
  input: ConfirmationResendInput,
  actorUserId: string,
): Promise<ConfirmationResendOperation> {
  await ensureEventMessagingDefaults(eventId);
  const prisma = getPrisma();
  let result: ConfirmationResendOperation;
  try {
    result = await prisma.$transaction(async (tx) => {
      const [source, settings] = await Promise.all([
        tx.messageOutbox.findFirst({
          where: { id: sourceMessageId, eventId },
          include: {
            registration: {
              select: { confirmationCode: true },
            },
          },
        }),
        tx.eventMessageSettings.findUniqueOrThrow({ where: { eventId } }),
      ]);
      if (!source) {
        throw new MessagingError(
          "MESSAGE_NOT_FOUND",
          "That confirmation message is no longer available.",
        );
      }
      if (
        source.recipientKind !== "REGISTRANT"
        || !registrationConfirmationTemplateKeys.has(source.templateKey)
        || !source.registrationId
        || source.retryOfMessageId !== null
      ) {
        throw new MessagingError(
          "MESSAGE_NOT_RESENDABLE",
          "Only a registrant’s original registration confirmation can be resent from this action.",
        );
      }
      if (source.status === "PENDING" || source.status === "PROCESSING") {
        throw new MessagingError(
          "MESSAGE_NOT_RESENDABLE",
          "This confirmation is already queued or processing. Wait for its result before creating another copy.",
        );
      }

      const recipientEmail = (
        input.correctedRecipientEmail || source.recipientEmail
      ).trim().toLowerCase();
      if (!zodlessEmailCheck(recipientEmail)) {
        throw new MessagingError(
          "MESSAGE_NOT_RESENDABLE",
          "Enter a valid corrected email address or use the original recipient.",
        );
      }
      const requestFingerprint = createHash("sha256")
        .update(JSON.stringify({
          version: 1,
          eventId,
          sourceMessageId: source.id,
          recipientEmail,
        }))
        .digest("hex");
      const idempotencyKey = `confirmation-resend:${eventId}:${source.id}:${input.clientRequestId}`;
      const existing = await tx.messageOutbox.findUnique({
        where: { idempotencyKey },
        select: {
          id: true,
          status: true,
          recipientEmail: true,
          metadata: true,
        },
      });
      if (existing) {
        const metadata = recordFromJson(existing.metadata);
        const storedFingerprint = typeof metadata.requestFingerprint === "string"
          ? metadata.requestFingerprint
          : null;
        if (
          (storedFingerprint && storedFingerprint !== requestFingerprint)
          || (!storedFingerprint && existing.recipientEmail.toLowerCase() !== recipientEmail)
        ) {
          throw new MessagingError(
            "IDEMPOTENCY_KEY_REUSED",
            "This resend request ID was already used with a different destination. Refresh the delivery log and create a new resend.",
          );
        }
        const storedMode = metadata.deliveryMode;
        return {
          sourceMessageId: source.id,
          messageId: existing.id,
          recipientEmail: existing.recipientEmail,
          deliveryMode: storedMode === "DISABLED"
            || storedMode === "LOCAL_CAPTURE"
            || storedMode === "EXTERNAL_EMAIL"
            ? storedMode
            : settings.deliveryMode,
          status: existing.status as MessageOutboxStatusValue,
          destinationChanged: existing.recipientEmail.toLowerCase()
            !== source.recipientEmail.toLowerCase(),
          replayed: true,
        };
      }

      const activeChild = await tx.messageOutbox.findFirst({
        where: {
          retryOfMessageId: source.id,
          status: { in: ["PENDING", "PROCESSING"] },
        },
        select: { id: true },
      });
      if (activeChild) {
        throw new MessagingError(
          "MESSAGE_NOT_RESENDABLE",
          "Another confirmation copy is already queued or processing. Wait for its result before creating a new resend.",
        );
      }

      const suppressed = settings.deliveryMode === "DISABLED";
      const message = await tx.messageOutbox.create({
        data: {
          eventId,
          registrationId: source.registrationId,
          templateVersionId: source.templateVersionId,
          templateKey: source.templateKey,
          recipientKind: "REGISTRANT",
          recipientEmail,
          recipientName: source.recipientName,
          senderNameSnapshot: source.senderNameSnapshot,
          senderEmailSnapshot: source.senderEmailSnapshot,
          replyToEmailSnapshot: source.replyToEmailSnapshot,
          subjectSnapshot: source.subjectSnapshot,
          bodyTextSnapshot: source.bodyTextSnapshot,
          metadata: {
            trigger: "STAFF_CONFIRMATION_RESEND",
            sourceMessageId: source.id,
            destinationChanged: recipientEmail !== source.recipientEmail.toLowerCase(),
            requestFingerprint,
            deliveryMode: settings.deliveryMode,
            realDelivery: settings.deliveryMode === "EXTERNAL_EMAIL",
          },
          idempotencyKey,
          correlationId: input.clientRequestId,
          retryOfMessageId: source.id,
          status: suppressed ? "SUPPRESSED" : "PENDING",
          lastError: suppressed
            ? "Delivery is disabled for this event."
            : null,
        },
        select: { id: true, status: true },
      });
      await tx.auditLog.createMany({
        data: [{
          eventId,
          actorUserId,
          action: "REGISTRATION_CONFIRMATION_RESEND_ENQUEUED",
          entityType: "MessageOutbox",
          entityId: `confirmation-resend:${source.id}:${input.clientRequestId}`,
          correlationId: input.clientRequestId,
          summary: suppressed
            ? `Recorded a suppressed confirmation copy for registration ${source.registration?.confirmationCode ?? source.registrationId}; no email was sent.`
            : settings.deliveryMode === "LOCAL_CAPTURE"
              ? `Created a local confirmation copy for registration ${source.registration?.confirmationCode ?? source.registrationId}; no email was sent.`
              : `Queued an audited confirmation resend for registration ${source.registration?.confirmationCode ?? source.registrationId} for later explicit email processing.`,
          metadata: {
            sourceMessageId: source.id,
            newMessageId: message.id,
            destinationChanged: recipientEmail !== source.recipientEmail.toLowerCase(),
            deliveryMode: settings.deliveryMode,
            immutableSourceSnapshot: true,
            contactRecordChanged: false,
            realDelivery: false,
          },
        }],
        skipDuplicates: true,
      });
      return {
        sourceMessageId: source.id,
        messageId: message.id,
        recipientEmail,
        deliveryMode: settings.deliveryMode,
        status: message.status as MessageOutboxStatusValue,
        destinationChanged: recipientEmail !== source.recipientEmail.toLowerCase(),
        replayed: false,
      };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError
      && (error.code === "P2002" || error.code === "P2034")
    ) {
      const idempotencyKey = `confirmation-resend:${eventId}:${sourceMessageId}:${input.clientRequestId}`;
      const replay = await prisma.messageOutbox.findUnique({
        where: { idempotencyKey },
        select: {
          id: true,
          status: true,
          recipientEmail: true,
          metadata: true,
          retryOf: { select: { recipientEmail: true } },
        },
      });
      if (replay) {
        const metadata = recordFromJson(replay.metadata);
        const requestedRecipientEmail = (
          input.correctedRecipientEmail || replay.retryOf?.recipientEmail || ""
        ).trim().toLowerCase();
        const requestedFingerprint = createHash("sha256")
          .update(JSON.stringify({
            version: 1,
            eventId,
            sourceMessageId,
            recipientEmail: requestedRecipientEmail,
          }))
          .digest("hex");
        const storedFingerprint = typeof metadata.requestFingerprint === "string"
          ? metadata.requestFingerprint
          : null;
        if (
          (storedFingerprint && storedFingerprint !== requestedFingerprint)
          || (!storedFingerprint && replay.recipientEmail.toLowerCase() !== requestedRecipientEmail)
        ) {
          throw new MessagingError(
            "IDEMPOTENCY_KEY_REUSED",
            "This resend request ID was already used with a different destination. Refresh the delivery log and create a new resend.",
          );
        }
        const storedMode = metadata.deliveryMode;
        result = {
          sourceMessageId,
          messageId: replay.id,
          recipientEmail: replay.recipientEmail,
          deliveryMode: storedMode === "DISABLED"
            || storedMode === "LOCAL_CAPTURE"
            || storedMode === "EXTERNAL_EMAIL"
            ? storedMode
            : "LOCAL_CAPTURE",
          status: replay.status as MessageOutboxStatusValue,
          destinationChanged: replay.recipientEmail.toLowerCase()
            !== (replay.retryOf?.recipientEmail ?? "").toLowerCase(),
          replayed: true,
        };
      } else {
        throw new MessagingError(
          "MESSAGE_NOT_RESENDABLE",
          "Another confirmation copy was queued at the same time. Refresh the delivery log before trying again.",
        );
      }
    } else {
      throw error;
    }
  }

  if (result.deliveryMode === "LOCAL_CAPTURE" && result.status === "PENDING") {
    const captured = await captureMessageIdsLocally([result.messageId]);
    if (captured.includes(result.messageId)) {
      return { ...result, status: "CAPTURED" };
    }
  }
  return result;
}

export async function retryMessage(
  eventId: string,
  messageId: string,
  input: MessageRetryInput,
  actorUserId: string,
  dependencies?: ExternalEmailDeliveryDependencies,
): Promise<MessageRetryOperation> {
  await ensureEventMessagingDefaults(eventId);
  const prisma = getPrisma();
  const idempotencyKey = messageRetryIdempotencyKey(
    eventId,
    input.clientRequestId,
  );
  let operation: MessageRetryOperation;
  try {
    operation = await prisma.$transaction(async (tx) => {
      const existing = await tx.messageOutbox.findUnique({
        where: { idempotencyKey },
        select: {
          id: true,
          status: true,
          retryOfMessageId: true,
          metadata: true,
        },
      });
      if (existing) {
        return replayMessageRetryOperation(
          existing,
          messageId,
          input,
        );
      }

      const [source, settings] = await Promise.all([
        tx.messageOutbox.findFirst({
          where: { id: messageId, eventId },
        }),
        tx.eventMessageSettings.findUniqueOrThrow({
          where: { eventId },
        }),
      ]);
      if (!source) {
        throw new MessagingError(
          "MESSAGE_NOT_FOUND",
          "That message is no longer available.",
        );
      }
      const expectedFingerprint = messageRetryRequestFingerprint({
        eventId,
        sourceMessageId: source.id,
        deliveryMode: settings.deliveryMode,
        registrationId: source.registrationId,
        templateVersionId: source.templateVersionId,
        templateKey: source.templateKey,
        recipientKind: source.recipientKind,
        recipientEmail: source.recipientEmail,
        recipientName: source.recipientName,
        senderNameSnapshot: source.senderNameSnapshot,
        senderEmailSnapshot: source.senderEmailSnapshot,
        replyToEmailSnapshot: source.replyToEmailSnapshot,
        subjectSnapshot: source.subjectSnapshot,
        bodyTextSnapshot: source.bodyTextSnapshot,
      });
      if (input.requestFingerprint !== expectedFingerprint) {
        throw new MessagingError(
          "PREVIEW_CHANGED",
          "This message or its delivery mode changed. Refresh the delivery log before retrying it.",
        );
      }
      if (settings.deliveryMode === "DISABLED") {
        throw new MessagingError(
          "DELIVERY_DISABLED",
          "Turn on message delivery before retrying this message.",
        );
      }
      if (
        source.status === "PENDING"
        || source.status === "PROCESSING"
      ) {
        throw new MessagingError(
          "MESSAGE_NOT_RETRYABLE",
          "This message is already queued or processing. Wait for its result before creating a copy.",
        );
      }
      if (
        settings.deliveryMode === "EXTERNAL_EMAIL"
        && source.status !== "FAILED"
      ) {
        throw new MessagingError(
          "MESSAGE_NOT_RETRYABLE",
          "Only failed real-email deliveries can be retried. This prevents duplicate email.",
        );
      }
      if (
        settings.deliveryMode === "EXTERNAL_EMAIL"
        && !getResendEmailAvailability().deliveryConfigured
        && !dependencies?.configuration
      ) {
        throw new MessagingError(
          "EXTERNAL_EMAIL_NOT_CONFIGURED",
          "Add the Resend API key before retrying real email.",
        );
      }
      const activeChild = await tx.messageOutbox.findFirst({
        where: {
          retryOfMessageId: source.id,
          status: { in: ["PENDING", "PROCESSING"] },
        },
        select: { id: true },
      });
      if (activeChild) {
        throw new MessagingError(
          "MESSAGE_NOT_RETRYABLE",
          "Another delivery copy is already queued or processing. Wait for its result before retrying this message.",
        );
      }

      const created = await tx.messageOutbox.create({
        data: {
          eventId,
          registrationId: source.registrationId,
          templateVersionId: source.templateVersionId,
          templateKey: source.templateKey,
          recipientKind: source.recipientKind,
          recipientEmail: source.recipientEmail,
          recipientName: source.recipientName,
          senderNameSnapshot: source.senderNameSnapshot,
          senderEmailSnapshot: source.senderEmailSnapshot,
          replyToEmailSnapshot: source.replyToEmailSnapshot,
          subjectSnapshot: source.subjectSnapshot,
          bodyTextSnapshot: source.bodyTextSnapshot,
          metadata: {
            trigger: "STAFF_MESSAGE_RETRY",
            sourceMessageId: source.id,
            requestFingerprint: input.requestFingerprint,
            deliveryMode: settings.deliveryMode,
            immutableSourceSnapshot: true,
            realDelivery: settings.deliveryMode === "EXTERNAL_EMAIL",
          },
          idempotencyKey,
          correlationId: input.clientRequestId,
          retryOfMessageId: source.id,
        },
        select: {
          id: true,
          status: true,
        },
      });
      await tx.auditLog.create({
        data: {
          eventId,
          actorUserId,
          action: "MESSAGE_RETRY_CREATED",
          entityType: "MessageOutbox",
          entityId: created.id,
          correlationId: input.clientRequestId,
          summary: settings.deliveryMode === "EXTERNAL_EMAIL"
            ? `Created an audited real-email retry from failed message ${source.id}.`
            : `Created a new local capture from message ${source.id}.`,
          metadata: {
            retryOfMessageId: source.id,
            newMessageId: created.id,
            deliveryMode: settings.deliveryMode,
            immutableSourceSnapshot: true,
            realDelivery: settings.deliveryMode === "EXTERNAL_EMAIL",
          },
        },
      });
      return {
        sourceMessageId: source.id,
        messageId: created.id,
        deliveryMode: settings.deliveryMode,
        status: created.status as MessageOutboxStatusValue,
        replayed: false,
      };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError
      && (error.code === "P2002" || error.code === "P2034")
    ) {
      const replay = await prisma.messageOutbox.findUnique({
        where: { idempotencyKey },
        select: {
          id: true,
          status: true,
          retryOfMessageId: true,
          metadata: true,
        },
      });
      if (!replay) {
        throw new MessagingError(
          "MESSAGE_NOT_RETRYABLE",
          "Another delivery copy was queued at the same time. Refresh the delivery log before trying again.",
        );
      }
      operation = replayMessageRetryOperation(
        replay,
        messageId,
        input,
      );
    } else {
      throw error;
    }
  }

  if (
    operation.deliveryMode === "EXTERNAL_EMAIL"
    && operation.status === "PENDING"
  ) {
    try {
      await processExternalEmailQueue(eventId, {
        messageIds: [operation.messageId],
        limit: 1,
        dependencies,
      });
    } catch (error) {
      asMessagingDeliveryError(error);
    }
  } else if (
    operation.deliveryMode === "LOCAL_CAPTURE"
    && operation.status === "PENDING"
  ) {
    await captureOneMessageLocally(operation.messageId, eventId);
  }

  const completed = await prisma.messageOutbox.findUnique({
    where: { id: operation.messageId },
    select: { status: true },
  });
  return completed
    ? {
        ...operation,
        status: completed.status as MessageOutboxStatusValue,
      }
    : operation;
}

export type MessageRetryOperation = {
  sourceMessageId: string;
  messageId: string;
  deliveryMode: "DISABLED" | "LOCAL_CAPTURE" | "EXTERNAL_EMAIL";
  status: MessageOutboxStatusValue;
  replayed: boolean;
};

function replayMessageRetryOperation(
  existing: {
    id: string;
    status: MessageOutboxStatus;
    retryOfMessageId: string | null;
    metadata: Prisma.JsonValue | null;
  },
  requestedSourceMessageId: string,
  input: MessageRetryInput,
): MessageRetryOperation {
  const metadata = recordFromJson(existing.metadata);
  const storedSourceMessageId = typeof metadata.sourceMessageId === "string"
    ? metadata.sourceMessageId
    : existing.retryOfMessageId;
  const storedFingerprint = typeof metadata.requestFingerprint === "string"
    ? metadata.requestFingerprint
    : null;
  if (
    storedSourceMessageId !== requestedSourceMessageId
    || existing.retryOfMessageId !== requestedSourceMessageId
    || storedFingerprint !== input.requestFingerprint
  ) {
    throw new MessagingError(
      "IDEMPOTENCY_KEY_REUSED",
      "This retry request ID was already used for a different message or payload. Refresh the delivery log and create a new retry.",
    );
  }
  const storedMode = metadata.deliveryMode;
  if (
    storedMode !== "DISABLED"
    && storedMode !== "LOCAL_CAPTURE"
    && storedMode !== "EXTERNAL_EMAIL"
  ) {
    throw new MessagingError(
      "IDEMPOTENCY_KEY_REUSED",
      "This retry request ID is already attached to an incompatible operation. Refresh the delivery log and create a new retry.",
    );
  }
  return {
    sourceMessageId: requestedSourceMessageId,
    messageId: existing.id,
    deliveryMode: storedMode,
    status: existing.status as MessageOutboxStatusValue,
    replayed: true,
  };
}

export async function retryMessageLocally(
  eventId: string,
  messageId: string,
  input: MessageRetryInput,
  actorUserId: string,
) {
  return retryMessage(eventId, messageId, input, actorUserId);
}

export async function processQueuedMessageIdsAfterCommit(
  messageIds: string[],
  dependencies?: ExternalEmailDeliveryDependencies,
) {
  const uniqueMessageIds = [...new Set(messageIds)];
  const result = {
    capturedIds: [] as string[],
    sentIds: [] as string[],
    failedIds: [] as string[],
    rescheduledIds: [] as string[],
    skippedIds: [] as string[],
  };
  if (uniqueMessageIds.length === 0) return result;

  const prisma = getPrisma();
  const messages = await prisma.messageOutbox.findMany({
    where: {
      id: { in: uniqueMessageIds },
      status: "PENDING",
    },
    select: {
      id: true,
      eventId: true,
      event: {
        select: {
          messageSettings: {
            select: { deliveryMode: true },
          },
        },
      },
    },
  });
  const externalByEvent = new Map<string, string[]>();
  for (const message of messages) {
    const mode = message.event.messageSettings?.deliveryMode ?? "LOCAL_CAPTURE";
    if (mode === "LOCAL_CAPTURE") {
      if (await captureOneMessageLocally(message.id, message.eventId)) {
        result.capturedIds.push(message.id);
      }
      continue;
    }
    if (mode === "EXTERNAL_EMAIL") {
      const ids = externalByEvent.get(message.eventId) ?? [];
      ids.push(message.id);
      externalByEvent.set(message.eventId, ids);
      continue;
    }
    result.skippedIds.push(message.id);
  }

  for (const [eventId, ids] of externalByEvent) {
    try {
      const external = await processExternalEmailQueue(eventId, {
        messageIds: ids,
        limit: ids.length,
        dependencies,
      });
      result.sentIds.push(...external.sentIds);
      result.failedIds.push(...external.failedIds);
      result.rescheduledIds.push(...external.rescheduledIds);
    } catch (error) {
      if (error instanceof ExternalEmailDeliveryError) {
        result.skippedIds.push(...ids);
        continue;
      }
      throw error;
    }
  }
  return result;
}

function publishedTemplateSource(
  templates: Array<{
    key: PrismaMessageTemplateKey;
    isEnabled: boolean;
    versions: Array<{ id: string; subjectTemplate: string; bodyTemplate: string }>;
  }>,
  key: MessageTemplateKey,
) {
  const configured = templates.find((template) => template.key === key);
  const version = configured?.versions[0];
  const fallback = DEFAULT_MESSAGE_TEMPLATES[key];
  return {
    isEnabled: configured?.isEnabled ?? true,
    templateVersionId: version?.id ?? null,
    subject: version?.subjectTemplate ?? fallback.subject,
    body: version?.bodyTemplate ?? fallback.body,
  };
}

export async function enqueuePublicRegistrationMessages(
  tx: Prisma.TransactionClient,
  input: RegistrationMessageInput,
): Promise<QueuedRegistrationMessages> {
  const registrantTemplateKey = selectRegistrationMessageTemplate({
    isWorker: input.registration.attendeeType === "WORKER",
    balanceCents: input.calculation.totalCents,
  });
  const [settingsRow, templates] = await Promise.all([
    tx.eventMessageSettings.findUnique({ where: { eventId: input.event.id } }),
    tx.eventMessageTemplate.findMany({
      where: {
        eventId: input.event.id,
        key: { in: [registrantTemplateKey, "INTERNAL_NEW_REGISTRATION"] },
      },
      select: {
        key: true,
        isEnabled: true,
        versions: {
          where: { status: "PUBLISHED" },
          orderBy: { versionNumber: "desc" },
          take: 1,
          select: { id: true, subjectTemplate: true, bodyTemplate: true },
        },
      },
    }),
  ]);
  const settings = settingsRow
    ? {
        deliveryMode: settingsRow.deliveryMode,
        senderName: settingsRow.senderName,
        senderEmail: settingsRow.senderEmail,
        replyToEmail: settingsRow.replyToEmail,
        internalNotificationEmails: stringArrayFromJson(settingsRow.internalNotificationEmails),
      }
    : fallbackSettings;
  const registrantName = `${input.identity.firstName} ${input.identity.lastName}`.trim();
  const attendeeSummary = registrationSummary(
    input.definition,
    input.responses,
    input.identity,
    input.attendeeResponses,
  );
  const commonContext: MessageTemplateContext = {
    registrant_name: registrantName,
    event_name: input.event.name,
    event_dates: formatMessageDateRange(input.event.startsAt, input.event.endsAt, { timeZone: input.event.timezone }),
    event_location: input.event.location || "Location to be announced",
    confirmation_code: input.registration.confirmationCode,
    attendee_summary: attendeeSummary,
    total_amount: formatMessageMoney(input.calculation.totalCents),
    balance_amount: formatMessageMoney(input.calculation.totalCents),
    payment_instructions: input.calculation.totalCents > 0
      ? "No card was charged. The event team will provide or confirm the next payment step."
      : "No balance is due at this time.",
    portal_url: REGISTRATION_MANAGE_LINK_SENTINEL,
    reply_to_email: settings.replyToEmail || settings.senderEmail || "the IMSDA event office",
  };
  const recipients: Array<{
    templateKey: MessageTemplateKey;
    kind: "REGISTRANT" | "INTERNAL";
    email: string;
    name: string;
  }> = [{
    templateKey: registrantTemplateKey,
    kind: "REGISTRANT",
    email: input.identity.email.trim().toLowerCase(),
    name: registrantName,
  }];
  for (const email of settings.internalNotificationEmails) {
    recipients.push({
      templateKey: "INTERNAL_NEW_REGISTRATION",
      kind: "INTERNAL",
      email,
      name: "IMSDA event team",
    });
  }

  const messageIds: string[] = [];
  const registrantMessageIds: string[] = [];
  const pendingMessageIds: string[] = [];
  for (const recipient of recipients) {
    const source = publishedTemplateSource(templates, recipient.templateKey);
    const rendered = renderMessageTemplate(
      { subject: source.subject, body: source.body },
      { ...commonContext, recipient_name: recipient.name },
    );
    if (!rendered.isComplete) {
      throw new MessagingError(
        "INVALID_TEMPLATE",
        `The ${recipient.templateKey.toLowerCase().replaceAll("_", " ")} template has unresolved tokens: ${rendered.unresolvedTokens.join(", ")}.`,
      );
    }
    const suppressed = settings.deliveryMode === "DISABLED" || !source.isEnabled;
    const message = await tx.messageOutbox.create({
      data: {
        eventId: input.event.id,
        registrationId: input.registration.id,
        templateVersionId: source.templateVersionId,
        templateKey: recipient.templateKey,
        recipientKind: recipient.kind,
        recipientEmail: recipient.email,
        recipientName: recipient.name,
        senderNameSnapshot: settings.senderName,
        senderEmailSnapshot: settings.senderEmail,
        replyToEmailSnapshot: settings.replyToEmail,
        subjectSnapshot: rendered.subject,
        bodyTextSnapshot: rendered.body,
        metadata: {
          trigger: "PUBLIC_REGISTRATION_SUBMITTED",
          confirmationCode: input.registration.confirmationCode,
          totalCents: input.calculation.totalCents,
          balanceCents: input.calculation.totalCents,
          attendeeType: input.registration.attendeeType,
          deliveryMode: settings.deliveryMode,
          realDelivery: settings.deliveryMode === "EXTERNAL_EMAIL",
        },
        idempotencyKey: messageDedupeKey(
          input.formVersionId,
          input.submissionIdempotencyKey,
          recipient.templateKey,
          recipient.email,
        ),
        correlationId: randomUUID(),
        status: suppressed ? "SUPPRESSED" : "PENDING",
        lastError: suppressed
          ? settings.deliveryMode === "DISABLED"
            ? "Delivery is disabled for this event."
            : "This message template is disabled."
          : null,
      },
    });
    messageIds.push(message.id);
    if (recipient.kind === "REGISTRANT") registrantMessageIds.push(message.id);
    if (!suppressed) pendingMessageIds.push(message.id);
  }
  return {
    messageIds,
    registrantMessageIds,
    pendingMessageIds,
    deliveryMode: settings.deliveryMode,
  };
}
