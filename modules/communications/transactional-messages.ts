import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { REGISTRATION_MANAGE_LINK_SENTINEL } from "@/modules/communications/manage-link";
import {
  DEFAULT_MESSAGE_TEMPLATES,
  formatMessageDateRange,
  formatMessageMoney,
  renderMessageTemplate,
  type MessageTemplateContext,
} from "@/modules/communications/templates";

type TransactionalTemplateKey =
  | "WAITLIST_JOINED"
  | "WAITLIST_PROMOTED"
  | "REGISTRATION_CANCELLED"
  | "REGISTRATION_CONTACT_UPDATED"
  | "REGISTRATION_TRANSFERRED_NEW_CONTACT"
  | "REGISTRATION_TRANSFERRED_PRIOR_CONTACT"
  | "ATTENDEE_SUBSTITUTED"
  | "PAYMENT_RECEIPT";

type TransactionalMessageInput = {
  eventId: string;
  registrationId: string;
  templateKey: TransactionalTemplateKey;
  correlationId: string;
  transitionKey: string;
  recipientEmail?: string;
  recipientName?: string;
  waitlistPosition?: number | null;
  paymentAmountCents?: number;
  paymentReference?: string;
  priorPersonName?: string;
  newPersonName?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

export type QueuedTransactionalMessage = {
  messageIds: string[];
  pendingMessageIds: string[];
  deliveryMode: "DISABLED" | "LOCAL_CAPTURE" | "EXTERNAL_EMAIL";
  skippedReason: "NO_REGISTRATION" | "NO_RECIPIENT" | null;
};

const fallbackSettings = {
  deliveryMode: "LOCAL_CAPTURE" as const,
  senderName: "IMSDA Events",
  senderEmail: null,
  replyToEmail: null,
};

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function snapshotString(
  snapshot: Record<string, unknown>,
  key: string,
  fallback = "",
) {
  const value = snapshot[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function moneyToCents(value: { toString(): string } | number) {
  return Math.max(0, Math.round(Number(value) * 100));
}

function transactionalIdempotencyKey(input: TransactionalMessageInput, recipientEmail: string) {
  const digest = createHash("sha256")
    .update([
      input.eventId,
      input.registrationId,
      input.templateKey,
      input.transitionKey,
      recipientEmail,
    ].join("\u0000"))
    .digest("hex");
  return `registration-transition:${digest}`;
}

function cancellationPaymentWording(input: {
  paidCents: number;
  refundedCents: number;
}) {
  if (input.paidCents === 0) {
    return "No successful payment is recorded, so no refund is currently due.";
  }
  const remainingPaidCents = Math.max(input.paidCents - input.refundedCents, 0);
  if (remainingPaidCents === 0) {
    return `${formatMessageMoney(input.paidCents)} in successful payments and ${formatMessageMoney(input.refundedCents)} in successful refunds remain recorded. No additional refund was created by this cancellation.`;
  }
  return `${formatMessageMoney(input.paidCents)} in successful payments and ${formatMessageMoney(input.refundedCents)} in successful refunds remain recorded. Cancellation did not automatically refund the remaining ${formatMessageMoney(remainingPaidCents)}; contact the event team about any refund due.`;
}

function paymentInstructions(
  key: TransactionalTemplateKey,
  balanceCents: number,
  paidCents: number,
  refundedCents: number,
) {
  if (key === "WAITLIST_JOINED") {
    return "No payment is due while this registration remains on the waitlist.";
  }
  if (key === "REGISTRATION_CANCELLED") {
    return cancellationPaymentWording({ paidCents, refundedCents });
  }
  if (key === "WAITLIST_PROMOTED") {
    return balanceCents > 0
      ? `${formatMessageMoney(balanceCents)} remains due. Use the private registration link to review the balance and continue payment.`
      : "No balance is due at this time.";
  }
  return balanceCents > 0
    ? `${formatMessageMoney(balanceCents)} remains due.`
    : "No balance is due at this time.";
}

function attendeeName(attendee: {
  profileSnapshot: Prisma.JsonValue;
  person: { firstName: string; lastName: string };
}) {
  const profile = jsonRecord(attendee.profileSnapshot);
  const firstName = snapshotString(profile, "firstName", attendee.person.firstName);
  const lastName = snapshotString(profile, "lastName", attendee.person.lastName);
  return `${firstName} ${lastName}`.trim();
}

async function enqueueTransactionalMessage(
  tx: Prisma.TransactionClient,
  input: TransactionalMessageInput,
): Promise<QueuedTransactionalMessage> {
  const [settingsRow, template, registration] = await Promise.all([
    tx.eventMessageSettings.findUnique({
      where: { eventId: input.eventId },
      select: {
        deliveryMode: true,
        senderName: true,
        senderEmail: true,
        replyToEmail: true,
      },
    }),
    tx.eventMessageTemplate.findUnique({
      where: {
        eventId_key: {
          eventId: input.eventId,
          key: input.templateKey,
        },
      },
      select: {
        isEnabled: true,
        versions: {
          where: { status: "PUBLISHED" },
          orderBy: { versionNumber: "desc" },
          take: 1,
          select: {
            id: true,
            subjectTemplate: true,
            bodyTemplate: true,
          },
        },
      },
    }),
    tx.registration.findFirst({
      where: {
        id: input.registrationId,
        eventId: input.eventId,
      },
      select: {
        id: true,
        confirmationCode: true,
        totalAmount: true,
        contactSnapshot: true,
        accountHolderPerson: {
          select: {
            firstName: true,
            lastName: true,
            normalizedEmail: true,
          },
        },
        event: {
          select: {
            name: true,
            startsAt: true,
            endsAt: true,
            timezone: true,
            location: true,
            supportContact: true,
          },
        },
        attendees: {
          orderBy: [{ position: "asc" }, { createdAt: "asc" }],
          select: {
            profileSnapshot: true,
            person: {
              select: {
                firstName: true,
                lastName: true,
              },
            },
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
        waitlistEntry: {
          select: { position: true },
        },
      },
    }),
  ]);
  const settings = settingsRow ?? fallbackSettings;
  if (!registration) {
    return {
      messageIds: [],
      pendingMessageIds: [],
      deliveryMode: settings.deliveryMode,
      skippedReason: "NO_REGISTRATION",
    };
  }

  const contact = jsonRecord(registration.contactSnapshot);
  const recipientEmail = (
    input.recipientEmail
    ?? snapshotString(
      contact,
      "email",
      registration.accountHolderPerson.normalizedEmail ?? "",
    )
  ).trim().toLowerCase();
  if (!recipientEmail) {
    return {
      messageIds: [],
      pendingMessageIds: [],
      deliveryMode: settings.deliveryMode,
      skippedReason: "NO_RECIPIENT",
    };
  }
  const defaultRecipientName = `${snapshotString(
    contact,
    "firstName",
    registration.accountHolderPerson.firstName,
  )} ${snapshotString(
    contact,
    "lastName",
    registration.accountHolderPerson.lastName,
  )}`.trim();
  const recipientName = input.recipientName?.trim() || defaultRecipientName;
  const totalCents = moneyToCents(registration.totalAmount);
  const paidCents = registration.payments.reduce(
    (sum, payment) => sum + moneyToCents(payment.amount),
    0,
  );
  const refundedCents = registration.payments.reduce(
    (sum, payment) => sum + payment.refunds.reduce(
      (refundSum, refund) => refundSum + moneyToCents(refund.amount),
      0,
    ),
    0,
  );
  const balanceCents = Math.max(totalCents - paidCents + refundedCents, 0);
  const waitlistPosition = input.waitlistPosition
    ?? registration.waitlistEntry?.position
    ?? 0;
  const source = template?.versions[0];
  const fallback = DEFAULT_MESSAGE_TEMPLATES[input.templateKey];
  const context: MessageTemplateContext = {
    recipient_name: recipientName || "Registrant",
    registrant_name: recipientName || "Registrant",
    event_name: registration.event.name,
    event_dates: formatMessageDateRange(
      registration.event.startsAt,
      registration.event.endsAt,
      { timeZone: registration.event.timezone },
    ),
    event_location: registration.event.location || "Location to be announced",
    confirmation_code: registration.confirmationCode,
    attendee_summary: registration.attendees
      .map((attendee, index) => `${index + 1}. ${attendeeName(attendee)}`)
      .join("\n") || "No attendee names are recorded.",
    total_amount: formatMessageMoney(totalCents),
    balance_amount: formatMessageMoney(balanceCents),
    payment_instructions: paymentInstructions(
      input.templateKey,
      balanceCents,
      paidCents,
      refundedCents,
    ),
    portal_url: REGISTRATION_MANAGE_LINK_SENTINEL,
    reply_to_email:
      settings.replyToEmail
      || settings.senderEmail
      || registration.event.supportContact
      || "the IMSDA event office",
    waitlist_position: waitlistPosition > 0 ? String(waitlistPosition) : "Pending",
    contact_email: recipientEmail,
    payment_amount: formatMessageMoney(input.paymentAmountCents ?? 0),
    payment_reference: input.paymentReference?.trim() || "Not provided",
    prior_person_name: input.priorPersonName?.trim() || "Prior attendee",
    new_person_name: input.newPersonName?.trim() || "Replacement attendee",
  };
  const rendered = renderMessageTemplate(
    {
      subject: source?.subjectTemplate ?? fallback.subject,
      body: source?.bodyTemplate ?? fallback.body,
    },
    context,
  );
  if (!rendered.isComplete) {
    throw new Error(
      `The ${input.templateKey} template has unresolved tokens: ${rendered.unresolvedTokens.join(", ")}.`,
    );
  }

  const suppressed = settings.deliveryMode === "DISABLED"
    || template?.isEnabled === false;
  const message = await tx.messageOutbox.upsert({
    where: {
      idempotencyKey: transactionalIdempotencyKey(input, recipientEmail),
    },
    update: {},
    create: {
      eventId: input.eventId,
      registrationId: input.registrationId,
      templateVersionId: source?.id ?? null,
      templateKey: input.templateKey,
      recipientKind: "REGISTRANT",
      recipientEmail,
      recipientName,
      senderNameSnapshot: settings.senderName,
      senderEmailSnapshot: settings.senderEmail,
      replyToEmailSnapshot: settings.replyToEmail,
      subjectSnapshot: rendered.subject,
      bodyTextSnapshot: rendered.body,
      metadata: {
        trigger: input.templateKey,
        transitionKey: input.transitionKey,
        confirmationCode: registration.confirmationCode,
        deliveryMode: settings.deliveryMode,
        realDelivery: settings.deliveryMode === "EXTERNAL_EMAIL",
        ...(input.metadata ?? {}),
      },
      idempotencyKey: transactionalIdempotencyKey(input, recipientEmail),
      correlationId: input.correlationId,
      status: suppressed ? "SUPPRESSED" : "PENDING",
      lastError: suppressed
        ? settings.deliveryMode === "DISABLED"
          ? "Delivery is disabled for this event."
          : "This message template is disabled."
        : null,
    },
    select: {
      id: true,
      status: true,
    },
  });
  return {
    messageIds: [message.id],
    pendingMessageIds: message.status === "PENDING" ? [message.id] : [],
    deliveryMode: settings.deliveryMode,
    skippedReason: null,
  };
}

export function enqueueWaitlistJoinedMessage(
  tx: Prisma.TransactionClient,
  input: Omit<TransactionalMessageInput, "templateKey">,
) {
  return enqueueTransactionalMessage(tx, {
    ...input,
    templateKey: "WAITLIST_JOINED",
  });
}

export function enqueueWaitlistPromotedMessage(
  tx: Prisma.TransactionClient,
  input: Omit<TransactionalMessageInput, "templateKey">,
) {
  return enqueueTransactionalMessage(tx, {
    ...input,
    templateKey: "WAITLIST_PROMOTED",
  });
}

export function enqueueRegistrationCancelledMessage(
  tx: Prisma.TransactionClient,
  input: Omit<TransactionalMessageInput, "templateKey">,
) {
  return enqueueTransactionalMessage(tx, {
    ...input,
    templateKey: "REGISTRATION_CANCELLED",
  });
}

export function enqueueRegistrationContactUpdatedMessage(
  tx: Prisma.TransactionClient,
  input: Omit<TransactionalMessageInput, "templateKey">,
) {
  return enqueueTransactionalMessage(tx, {
    ...input,
    templateKey: "REGISTRATION_CONTACT_UPDATED",
  });
}

export function enqueueRegistrationTransferredNewContactMessage(
  tx: Prisma.TransactionClient,
  input: Omit<TransactionalMessageInput, "templateKey">,
) {
  return enqueueTransactionalMessage(tx, {
    ...input,
    templateKey: "REGISTRATION_TRANSFERRED_NEW_CONTACT",
  });
}

export function enqueueRegistrationTransferredPriorContactMessage(
  tx: Prisma.TransactionClient,
  input: Omit<TransactionalMessageInput, "templateKey">,
) {
  return enqueueTransactionalMessage(tx, {
    ...input,
    templateKey: "REGISTRATION_TRANSFERRED_PRIOR_CONTACT",
  });
}

export function enqueueAttendeeSubstitutedMessage(
  tx: Prisma.TransactionClient,
  input: Omit<TransactionalMessageInput, "templateKey">,
) {
  return enqueueTransactionalMessage(tx, {
    ...input,
    templateKey: "ATTENDEE_SUBSTITUTED",
  });
}

export function enqueuePaymentReceiptMessage(
  tx: Prisma.TransactionClient,
  input: {
    eventId: string;
    registrationId: string;
    paymentId: string;
    paymentAttemptId: string;
    amountCents: number;
    providerPaymentId: string;
    correlationId?: string;
  },
) {
  return enqueueTransactionalMessage(tx, {
    eventId: input.eventId,
    registrationId: input.registrationId,
    templateKey: "PAYMENT_RECEIPT",
    correlationId: input.correlationId ?? randomUUID(),
    transitionKey: `square-payment:${input.paymentAttemptId}:${input.providerPaymentId}`,
    paymentAmountCents: input.amountCents,
    paymentReference: input.providerPaymentId,
    metadata: {
      paymentId: input.paymentId,
      paymentAttemptId: input.paymentAttemptId,
      provider: "SQUARE",
    },
  });
}
