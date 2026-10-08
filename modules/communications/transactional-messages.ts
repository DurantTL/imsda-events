import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { REGISTRATION_MANAGE_LINK_SENTINEL } from "@/modules/communications/manage-link";
import {
  DEFAULT_MESSAGE_TEMPLATES,
  formatMessageDateRange,
  formatMessageMoney,
  renderMessageTemplate,
  showsPerAttendeeQrs,
  type MessageTemplateContext,
  withChurchBilledLinkWording,
  withChurchBilledPriceWording,
  withGroupBilledWording,
} from "@/modules/communications/templates";
import { currentPricingSnapshot, perPersonPriceFromSnapshot, perPersonPriceInline } from "@/modules/club-registrations/per-person-price";
import {
  buildHotelInformationBlock,
  buildPaymentStatusBlock,
  buildRegistrationCheckinTokens,
  buildSeminarPreferencesBlock,
  withPerAttendeeQrImages,
  type PaymentState,
} from "@/modules/communications/message-blocks";
import { buildRegistrationSeminarPreferences } from "@/modules/communications/seminar-preferences";
import { linkQueuedMessageFiles } from "@/modules/communications/message-files";
import { messageFileIdsInHtml } from "@/modules/communications/message-file-rules";

type TransactionalTemplateKey =
  | "REGISTRATION_CONFIRMATION_PAID"
  | "REGISTRATION_CONFIRMATION_UNPAID"
  | "REGISTRATION_CONFIRMATION_ORGANIZATION_BILLED"
  | "WORKER_CONFIRMATION"
  | "WAITLIST_JOINED"
  | "WAITLIST_PROMOTED"
  | "WAITLIST_REMOVED"
  | "REGISTRATION_CANCELLED"
  | "REGISTRATION_REACTIVATED"
  | "REGISTRATION_CONTACT_UPDATED"
  | "REGISTRATION_UPDATED"
  | "REGISTRATION_TRANSFERRED_NEW_CONTACT"
  | "REGISTRATION_TRANSFERRED_PRIOR_CONTACT"
  | "ATTENDEE_SUBSTITUTED"
  | "REGISTRATION_ACCESS_RECOVERY"
  | "EVENT_ANNOUNCEMENT"
  | "CUSTOM_MESSAGE"
  | "PAYMENT_RECEIPT"
  | "REFUND_NOTICE"
  // Sent one at a time by the transactional path only when staff choose a set
  // of registrations to send it to; the event-wide reminder batch renders its
  // own copy against the reminder audience.
  | "BALANCE_REMINDER";

type SelectedAudienceMessageTemplateKey =
  | "BALANCE_REMINDER"
  | "EVENT_ANNOUNCEMENT"
  | "CUSTOM_MESSAGE"
  | "REGISTRATION_CONFIRMATION_PAID"
  | "REGISTRATION_CONFIRMATION_UNPAID"
  | "REGISTRATION_CONFIRMATION_ORGANIZATION_BILLED"
  | "WORKER_CONFIRMATION";

type TransactionalMessageInput = {
  eventId: string;
  registrationId: string;
  templateKey: TransactionalTemplateKey;
  correlationId: string;
  transitionKey: string;
  recipientEmail?: string;
  recipientName?: string;
  waitlistPosition?: number | null;
  waitlistRemovalReason?: string;
  paymentAmountCents?: number;
  paymentReference?: string;
  refundAmountCents?: number;
  refundReference?: string;
  priorPersonName?: string;
  newPersonName?: string;
  announcementTitle?: string;
  announcementBody?: string;
  changeCategory?: RegistrationUpdateCategory;
  /**
   * The pricing snapshot to show a church-billed registrant when it is not stored yet: an amendment
   * queues its notice before the AMENDMENT operation that holds the new snapshot exists (#621).
   */
  pricingSnapshot?: Record<string, unknown>;
  /** Change notices: what was just saved, per seminar field, in ranked order. */
  seminarPreferences?: Array<{
    attendeeName: string;
    fields: Array<{ label: string; choices: string[] }>;
  }>;
  /**
   * A broadcast loads every recipient's seminar block in a few queries and
   * passes each one in, so the send transaction does not query per recipient.
   */
  seminarPreferencesBlock?: string;
  /**
   * A batch that links the files of all its messages in one go afterwards (`linkQueuedMessageFiles`) sets this, so
   * the send transaction does not repeat the same lookups for every recipient.
   */
  deferFileLinking?: boolean;
  /** An announcement's own attachments, sent alongside the template version's (#824). */
  announcementFileIds?: readonly string[];
  metadata?: Record<string, string | number | boolean | null>;
};

export type RegistrationUpdateCategory =
  | "REGISTRATION_DETAILS"
  | "SEMINAR_PREFERENCES";

const registrationUpdateCategoryLabels: Record<RegistrationUpdateCategory, string> = {
  REGISTRATION_DETAILS: "Registration details",
  SEMINAR_PREFERENCES: "Seminar preferences",
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

const SEMINAR_TOKEN_PATTERN = /\{\{\s*seminar_preferences\s*\}\}/;

const waitlistTemplateKeys: ReadonlySet<TransactionalTemplateKey> = new Set([
  "WAITLIST_JOINED",
  "WAITLIST_PROMOTED",
  "WAITLIST_REMOVED",
]);

/**
 * Puts a "Location" line under the message's heading when its template does
 * not already show `{{event_location}}`. A template that does is left alone,
 * so staff wording is never doubled.
 */
function withLocationLine(body: string) {
  if (body.includes("{{event_location}}")) return body;
  const line = "**Location:** {{event_location}}";
  const heading = body.match(/^# .*(\r?\n|$)/);
  return heading
    ? `${heading[0].trimEnd()}\n\n${line}\n${body.slice(heading[0].length)}`
    : `${line}\n\n${body}`;
}

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

function safeWaitlistRemovalReason(value?: string) {
  return value?.trim()
    .replaceAll("{{", "{ {")
    .replaceAll("}}", "} }")
    || "No reason was provided.";
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
  approvedInstructions: string | null | undefined,
  billingMode: "ATTENDEE_PAY" | "DEFERRED_ORGANIZATION_INVOICE",
) {
  if (key === "WAITLIST_JOINED") {
    return "";
  }
  if (key === "REGISTRATION_CANCELLED" || key === "WAITLIST_REMOVED") {
    return cancellationPaymentWording({ paidCents, refundedCents });
  }
  if (key === "WAITLIST_PROMOTED") {
    return billingMode === "ATTENDEE_PAY" && balanceCents > 0
      ? approvedInstructions?.trim() || ""
      : "";
  }
  return billingMode === "ATTENDEE_PAY" && balanceCents > 0
    ? approvedInstructions?.trim() || ""
    : "";
}

/**
 * Which payment section a transition's message shows. The trigger decides it,
 * not the arithmetic: a waitlist confirmation with a nonzero total must still
 * say "no payment is due", and a cancellation must not ask anyone to pay.
 */
function paymentStateForTemplate(
  key: TransactionalTemplateKey,
  input: {
    totalCents: number;
    balanceCents: number;
    billingMode?: "ATTENDEE_PAY" | "DEFERRED_ORGANIZATION_INVOICE" | null;
    /** A "Group" registration (#650): billed to its contact, not to an organization. */
    billedToGroup?: boolean;
  },
): PaymentState {
  if (key === "REGISTRATION_CONFIRMATION_ORGANIZATION_BILLED") {
    return input.billedToGroup ? "GROUP_INVOICED" : "ORGANIZATION_INVOICED";
  }
  if (key === "WAITLIST_JOINED") return "WAITLISTED";
  if (key === "REGISTRATION_CANCELLED" || key === "WAITLIST_REMOVED") return "CANCELLED";
  // A church-billed (deferred-organization) event never asks the attendee or
  // director to pay: every other message says the organization is invoiced.
  if (input.billingMode === "DEFERRED_ORGANIZATION_INVOICE") {
    return input.billedToGroup ? "GROUP_INVOICED" : "ORGANIZATION_INVOICED";
  }
  if (key === "WAITLIST_PROMOTED") return "WAITLIST_PROMOTED";
  if (input.totalCents <= 0) return "COMPLIMENTARY";
  return input.balanceCents > 0 ? "BALANCE_DUE" : "PAID";
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
            files: { select: { fileId: true } },
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
        status: true,
        totalAmount: true,
        contactSnapshot: true,
        publicFormSubmission: { select: { pricingSnapshot: true } },
        // The latest amendment's pricing wins over the original submission's (#621).
        operations: { where: { type: "AMENDMENT" }, orderBy: { createdAt: "desc" }, take: 1, select: { afterSnapshot: true } },
        location: { select: { name: true, address: true } },
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
            billingMode: true,
            paymentInstructionVersions: {
              orderBy: { versionNumber: "desc" },
              take: 1,
              select: { instructions: true },
            },
            hotelName: true,
            hotelBookingUrl: true,
            hotelPhone: true,
            hotelGroupName: true,
            hotelRate: true,
            hotelInstructions: true,
          },
        },
        attendees: {
          orderBy: [{ position: "asc" }, { createdAt: "asc" }],
          select: {
            id: true,
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
        groupRegistration: { select: { id: true } },
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
  const isDeferredOrganizationBilling =
    registration.event.billingMode === "DEFERRED_ORGANIZATION_INVOICE";
  // Nothing is payable online on a church-billed event, so no token may
  // present the estimated church amount as an attendee balance.
  const balanceCents = isDeferredOrganizationBilling
    ? 0
    : Math.max(totalCents - paidCents + refundedCents, 0);
  const waitlistPosition = input.waitlistPosition
    ?? registration.waitlistEntry?.position
    ?? 0;
  const source = template?.versions[0];
  const fallback = DEFAULT_MESSAGE_TEMPLATES[input.templateKey];
  const instructions = paymentInstructions(
    input.templateKey,
    balanceCents,
    paidCents,
    refundedCents,
    registration.event.paymentInstructionVersions?.[0]?.instructions,
    registration.event.billingMode,
  );
  // The organiser's published address, which is what a "questions? contact …"
  // line means. The reply-to is a delivery header and can be a no-reply.
  const eventContactEmail = registration.event.supportContact?.trim()
    || settings.replyToEmail
    || settings.senderEmail
    || "the IMSDA event office";
  // A "Group" (#650) is billed to its contact and is shown its price and total;
  // only a church-billed club registrant sees the per-person price alone (#621).
  const billedToGroup = isDeferredOrganizationBilling && Boolean(registration.groupRegistration);
  const churchBilled = isDeferredOrganizationBilling && !billedToGroup;
  const churchWordedBody = withGroupBilledWording(
    withChurchBilledPriceWording(
      withChurchBilledLinkWording(
        source?.bodyTemplate ?? fallback.body,
        isDeferredOrganizationBilling,
      ),
      churchBilled,
    ),
    billedToGroup,
  );
  // A church-billed registrant sees the per-person price only, never a total or balance (#621).
  const perPersonNotice = churchBilled
    ? perPersonPriceInline(perPersonPriceFromSnapshot(
        input.pricingSnapshot ?? currentPricingSnapshot(registration),
        undefined,
        registration.attendees.map((attendee) => attendeeName(attendee)),
      ))
    : null;
  // A waitlist email for a club at a location says which location, even when
  // the template (a customized one, or one of the defaults) has no location
  // line of its own (#599).
  const publishedBody = registration.location && waitlistTemplateKeys.has(input.templateKey)
    ? withLocationLine(churchWordedBody)
    : churchWordedBody;
  // An announcement shows every attendee's own labelled pass QR. One image token
  // cannot hold several pictures, so a party's `![…]({{checkin_qr_image}})` is
  // swapped for the per-attendee block.
  const announcementBody = showsPerAttendeeQrs(input.templateKey)
    ? withPerAttendeeQrImages(publishedBody, registration.attendees.length)
    : publishedBody;
  const bodyTemplate = input.changeCategory === "SEMINAR_PREFERENCES"
    && input.seminarPreferences
    && !announcementBody.includes("{{seminar_preferences}}")
    ? `${announcementBody.trimEnd()}\n\n### Seminar preferences\n\n{{seminar_preferences}}`
    : announcementBody;
  // A change notice carries the labels that were just saved; every other message
  // reads the registration's own answers and any seminar assignment.
  // Loaded only when the message actually uses the token.
  const usesSeminarPreferences = SEMINAR_TOKEN_PATTERN.test(bodyTemplate)
    || SEMINAR_TOKEN_PATTERN.test(source?.subjectTemplate ?? fallback.subject);
  const seminarPreferences = input.seminarPreferences
    ? buildSeminarPreferencesBlock(input.seminarPreferences.map((attendee) => ({
        name: attendee.attendeeName,
        fields: attendee.fields.map((field) => ({ ...field, assigned: [] })),
      })))
    : input.seminarPreferencesBlock !== undefined
      ? input.seminarPreferencesBlock
      : usesSeminarPreferences
        ? await buildRegistrationSeminarPreferences(tx, {
            eventId: input.eventId,
            registrationId: registration.id,
          })
        : "";
  const context: MessageTemplateContext = {
    recipient_name: recipientName || "Registrant",
    // The person the registration belongs to, which is not always the person
    // this specific message goes to — a transfer notice reaches two people.
    registrant_name: defaultRecipientName || recipientName || "Registrant",
    event_name: registration.event.name,
    event_dates: formatMessageDateRange(
      registration.event.startsAt,
      registration.event.endsAt,
      { timeZone: registration.event.timezone },
    ),
    // A club registration at a location names that location (#413, #599).
    event_location: registration.location
      ? [registration.location.name, registration.location.address].filter(Boolean).join(", ")
      : registration.event.location || "Location to be announced",
    confirmation_code: registration.confirmationCode,
    attendee_summary: registration.attendees
      .map((attendee, index) => `${index + 1}. ${attendeeName(attendee)}`)
      .join("\n") || "No attendee names are recorded.",
    total_amount: perPersonNotice ?? formatMessageMoney(totalCents),
    restored_status: registration.status,
    balance_amount: perPersonNotice || billedToGroup ? "Nothing is due online." : formatMessageMoney(balanceCents),
    payment_instructions: instructions,
    portal_url: REGISTRATION_MANAGE_LINK_SENTINEL,
    reply_to_email:
      settings.replyToEmail
      || settings.senderEmail
      || registration.event.supportContact
      || "the IMSDA event office",
    waitlist_position: waitlistPosition > 0 ? String(waitlistPosition) : "Pending",
    waitlist_removal_reason: safeWaitlistRemovalReason(input.waitlistRemovalReason),
    contact_email: eventContactEmail,
    registration_contact_email: recipientEmail,
    hotel_information: buildHotelInformationBlock(registration.event),
    payment_status_block: buildPaymentStatusBlock({
      state: paymentStateForTemplate(input.templateKey, {
        totalCents,
        balanceCents,
        billingMode: registration.event.billingMode,
        billedToGroup,
      }),
      totalCents,
      paidCents,
      balanceCents,
      waitlistPosition,
      paymentInstructions: instructions,
      portalUrl: REGISTRATION_MANAGE_LINK_SENTINEL,
      cancellationNote: cancellationPaymentWording({ paidCents, refundedCents }),
      perPersonNotice,
    }),
    ...buildRegistrationCheckinTokens({
      confirmationCode: registration.confirmationCode,
      attendeeIds: registration.attendees.map((attendee) => attendee.id),
      attendees: showsPerAttendeeQrs(input.templateKey)
        ? registration.attendees.map((attendee) => ({
            id: attendee.id,
            name: attendeeName(attendee),
          }))
        : null,
    }),
    payment_amount: formatMessageMoney(input.paymentAmountCents ?? 0),
    payment_reference: input.paymentReference?.trim() || "Not provided",
    refund_amount: formatMessageMoney(input.refundAmountCents ?? 0),
    refund_reference: input.refundReference?.trim() || "Not provided",
    prior_person_name: input.priorPersonName?.trim() || "Prior attendee",
    new_person_name: input.newPersonName?.trim() || "Replacement attendee",
    announcement_title: input.announcementTitle?.trim() || "Event update",
    announcement_body: input.announcementBody?.trim() || "Open your registration for the latest event information.",
    change_category: input.changeCategory
      ? registrationUpdateCategoryLabels[input.changeCategory]
      : "Registration details",
    seminar_preferences: seminarPreferences,
  };
  const rendered = renderMessageTemplate(
    {
      subject: source?.subjectTemplate ?? fallback.subject,
      body: bodyTemplate,
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
      bodyHtmlSnapshot: rendered.bodyHtml,
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
  // The template version's attachments, the announcement's, and the images the body embeds (#824).
  const hasFiles = (source?.files?.length ?? 0) > 0
    || (input.announcementFileIds?.length ?? 0) > 0
    || messageFileIdsInHtml(rendered.bodyHtml).length > 0;
  if (hasFiles && !input.deferFileLinking) {
    await linkQueuedMessageFiles(tx, {
      eventId: input.eventId,
      messageIds: [message.id],
      extraAttachmentFileIds: input.announcementFileIds ?? [],
    });
  }
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

export function enqueueWaitlistRemovedMessage(
  tx: Prisma.TransactionClient,
  input: Omit<TransactionalMessageInput, "templateKey">,
) {
  return enqueueTransactionalMessage(tx, {
    ...input,
    templateKey: "WAITLIST_REMOVED",
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

export function enqueueRegistrationReactivatedMessage(
  tx: Prisma.TransactionClient,
  input: Omit<TransactionalMessageInput, "templateKey">,
) {
  return enqueueTransactionalMessage(tx, {
    ...input,
    templateKey: "REGISTRATION_REACTIVATED",
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

export function enqueueRegistrationUpdatedMessage(
  tx: Prisma.TransactionClient,
  input: Omit<TransactionalMessageInput, "templateKey" | "changeCategory" | "metadata"> & {
    changeCategory: RegistrationUpdateCategory;
  },
) {
  if (!registrationUpdateCategoryLabels[input.changeCategory]) {
    throw new Error("That registration update category is not permitted in a confirmation message.");
  }
  if (input.changeCategory === "SEMINAR_PREFERENCES" && !input.seminarPreferences) {
    throw new Error("Seminar preference labels are required in a confirmation message.");
  }
  return enqueueTransactionalMessage(tx, {
    ...input,
    templateKey: "REGISTRATION_UPDATED",
    metadata: {
      changeCategory: input.changeCategory,
    },
  });
}

export function enqueueRegistrationAccessRecoveryMessage(
  tx: Prisma.TransactionClient,
  input: Omit<TransactionalMessageInput, "templateKey">,
) {
  return enqueueTransactionalMessage(tx, {
    ...input,
    templateKey: "REGISTRATION_ACCESS_RECOVERY",
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

export function enqueueEventAnnouncementMessage(
  tx: Prisma.TransactionClient,
  input: Omit<TransactionalMessageInput, "templateKey"> & {
    announcementTitle: string;
    announcementBody: string;
  },
) {
  return enqueueTransactionalMessage(tx, {
    ...input,
    templateKey: "EVENT_ANNOUNCEMENT",
  });
}

/**
 * One message in a staff-chosen batch.
 *
 * It goes through the same renderer as every automatic message, so the tokens,
 * the disabled-template and delivery-mode suppression, the manage-link
 * sentinel, and the per-registration idempotency key all behave identically.
 * `transitionKey` carries the batch id, which is what makes re-posting the
 * same batch reuse its messages instead of sending them twice.
 */
export function enqueueSelectedAudienceMessage(
  tx: Prisma.TransactionClient,
  input: Omit<TransactionalMessageInput, "templateKey" | "transitionKey"> & {
    templateKey: SelectedAudienceMessageTemplateKey;
    batchId: string;
  },
) {
  const { batchId, ...rest } = input;
  return enqueueTransactionalMessage(tx, {
    ...rest,
    transitionKey: `selected-audience:${batchId}`,
  });
}

export function enqueuePaymentReceiptMessage(
  tx: Prisma.TransactionClient,
  input: {
    eventId: string;
    registrationId: string;
    paymentId: string;
    /**
     * Absent for a payment Square took outside this app (an invoice, a payment
     * link, the Virtual Terminal), which the webhook matches by confirmation
     * code and so has no attempt behind it. The provider payment id alone
     * still keys the transition uniquely.
     */
    paymentAttemptId?: string | null;
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
    transitionKey: `square-payment:${input.paymentAttemptId ?? "external"}:${input.providerPaymentId}`,
    paymentAmountCents: input.amountCents,
    paymentReference: input.providerPaymentId,
    metadata: {
      paymentId: input.paymentId,
      paymentAttemptId: input.paymentAttemptId ?? null,
      provider: "SQUARE",
    },
  });
}

export function enqueueRefundNoticeMessage(
  tx: Prisma.TransactionClient,
  input: {
    eventId: string;
    registrationId: string;
    refundId: string;
    amountCents: number;
    reference?: string;
    provider: "MANUAL" | "SQUARE";
    providerRefundId?: string;
    correlationId?: string;
  },
) {
  return enqueueTransactionalMessage(tx, {
    eventId: input.eventId,
    registrationId: input.registrationId,
    templateKey: "REFUND_NOTICE",
    correlationId: input.correlationId ?? randomUUID(),
    transitionKey: `refund:${input.provider}:${input.refundId}:${input.providerRefundId ?? ""}`,
    refundAmountCents: input.amountCents,
    refundReference: input.reference,
    metadata: {
      refundId: input.refundId,
      provider: input.provider,
      ...(input.providerRefundId ? { providerRefundId: input.providerRefundId } : {}),
    },
  });
}
