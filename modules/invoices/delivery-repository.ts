import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { lockEvent } from "@/modules/attendance-reconciliation/repository";
import { getBillingResponsibilityView } from "@/modules/billing-responsibility/repository";
import { escapeMarkdown, renderEmailBodyHtml } from "@/modules/communications/email-html";
import { ensureEventMessagingDefaults, processQueuedMessageIdsAfterCommit } from "@/modules/communications/messaging-repository";
import { directorGrantIsActive } from "@/modules/organizations/director-grants-domain";
import { getPlatformSettings } from "@/modules/system-admin/platform-settings";
import { contactsMatch, type InvoiceContact, type InvoiceSnapshot } from "@/modules/invoices/domain";
import {
  INVOICE_PDF_GENERATOR_VERSION,
  MAX_ATTACHMENT_BYTES,
  buildRecipientCandidates,
  defaultInvoiceBody,
  defaultInvoiceSubject,
  effectivePaymentInstructions,
  invoicePdfFilename,
  isDeliveryProblem,
  neutralizePlaceholders,
  recipientDeliveryStatus,
  recipientsFingerprint,
  selectRecipients,
  sendMessageSchema,
  type RecipientCandidate,
  type RecipientDeliveryStatus,
} from "@/modules/invoices/delivery-domain";
import { formatPdfMoney, renderInvoicePdf } from "@/modules/invoices/invoice-pdf";
import { InvoiceError, contactOfGroup } from "@/modules/invoices/repository";

/**
 * Delivering a finalized invoice (#168). Caleb's decisions (Oct 4, 2026): an email with the invoice PDF attached,
 * sent only when conference staff send it; the church's active billing contact (never the form submitter) plus the
 * club directors of the clubs on the invoice, each of whom staff can untick; every send audited and recorded.
 *
 * - The PDF is made from the finalized version's immutable snapshot, once, and stored (`InvoiceVersionDocument`,
 *   bytes in `MessageAttachment`, hash recorded and checked by the database). Every send and download uses those
 *   stored bytes, so a resend can never differ; each send verifies the bytes still hash to the recorded value.
 * - A send queues one message per recipient through the existing outbox (so delivery, retries, bounces and the
 *   event's delivery mode, including DISABLED which records the message as suppressed, behave as for every other
 *   message), all carrying the same attachment, and writes an append-only `InvoiceDelivery` record: version,
 *   sequence, who sent it and when, and a recipient row per message. Status and bounce are read from the outbox.
 * - Only a FINALIZED version can be sent; a version that a revision replaced cannot (the database refuses it too).
 * - Recipients are the CURRENT active billing contact, while the PDF keeps the contact it was finalized with; the
 *   screen flags a changed contact before sending.
 * - Audit rows carry ids, counts and hashes, never an email address or name.
 * - Nothing here is automatic: no schedule, no reminder, no send on finalization.
 */

type Client = Prisma.TransactionClient | PrismaClient;

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

// ---------------------------------------------------------------------------------------------
// The PDF
// ---------------------------------------------------------------------------------------------

export type InvoiceDocument = { id: string; attachmentId: string; sha256: string; filename: string; sizeBytes: number; createdAt: string; created: boolean };

const versionForPdfSelect = {
  id: true,
  invoiceId: true,
  eventId: true,
  status: true,
  number: true,
  revision: true,
  finalizedAt: true,
  groupTitle: true,
  organizationName: true,
  contactName: true,
  contactEmail: true,
  contactRoleLabel: true,
  supersedesVersionId: true,
  snapshot: true,
  event: { select: { name: true, timezone: true, invoicePaymentInstructions: true } },
} satisfies Prisma.InvoiceVersionSelect;

function sha256Hex(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The PDF of a finalized (or since superseded) version, made on first use and the same stored bytes ever after.
 * Staff can download any finalized version's PDF; only a FINALIZED version can be sent (checked by `sendInvoiceVersion`).
 */
export async function ensureInvoiceDocument(eventId: string, versionId: string, client: Client = getPrisma()): Promise<InvoiceDocument> {
  const existing = await client.invoiceVersionDocument.findFirst({
    where: { invoiceVersionId: versionId, eventId },
    select: { id: true, attachmentId: true, sha256: true, createdAt: true, attachment: { select: { filename: true, sizeBytes: true } } },
  });
  if (existing) {
    return { id: existing.id, attachmentId: existing.attachmentId, sha256: existing.sha256, filename: existing.attachment.filename, sizeBytes: existing.attachment.sizeBytes, createdAt: existing.createdAt.toISOString(), created: false };
  }
  const version = await client.invoiceVersion.findFirst({ where: { id: versionId, eventId }, select: versionForPdfSelect });
  if (!version) throw new InvoiceError("That invoice version does not belong to this event.", "VERSION_NOT_FOUND");
  if ((version.status !== "FINALIZED" && version.status !== "SUPERSEDED") || !version.number || !version.finalizedAt) {
    throw new InvoiceError("Only a finalized invoice has a PDF.", "NOT_FINALIZED");
  }
  const prior = version.supersedesVersionId
    ? await client.invoiceVersion.findUnique({ where: { id: version.supersedesVersionId }, select: { number: true } })
    : null;
  const platform = await getPlatformSettings();
  const paymentInstructions = effectivePaymentInstructions(version.event.invoicePaymentInstructions);
  const bytes = await renderInvoicePdf({
    headerName: platform.organizationName,
    number: version.number,
    issuedAt: version.finalizedAt,
    timezone: version.event.timezone,
    supersedesNumber: prior?.number ?? null,
    contact: version.contactName && version.contactEmail ? { name: version.contactName, email: version.contactEmail, roleLabel: version.contactRoleLabel ?? "" } : null,
    organizationName: version.organizationName,
    groupTitle: version.groupTitle,
    snapshot: version.snapshot as unknown as InvoiceSnapshot,
    paymentInstructions,
  });
  const sha256 = sha256Hex(bytes);
  const filename = invoicePdfFilename(version.number);
  const prisma = client as PrismaClient;
  try {
    const created = await prisma.$transaction(async (tx) => {
      const attachment = await tx.messageAttachment.create({
        data: { eventId, filename, contentType: "application/pdf", sizeBytes: bytes.byteLength, sha256, content: Buffer.from(bytes) },
        select: { id: true },
      });
      return tx.invoiceVersionDocument.create({
        data: { eventId, invoiceId: version.invoiceId, invoiceVersionId: version.id, attachmentId: attachment.id, sha256, generatorVersion: INVOICE_PDF_GENERATOR_VERSION, paymentInstructions, headerName: platform.organizationName },
        select: { id: true, attachmentId: true, createdAt: true },
      });
    });
    return { id: created.id, attachmentId: created.attachmentId, sha256, filename, sizeBytes: bytes.byteLength, createdAt: created.createdAt.toISOString(), created: true };
  } catch (error) {
    // Two requests made it at once: the first one's document is the document.
    if (isUniqueViolation(error)) {
      const winner = await ensureInvoiceDocument(eventId, versionId, client);
      return { ...winner, created: false };
    }
    throw error;
  }
}

/** The stored PDF bytes, verified against the recorded hash. Never regenerated. */
export async function readInvoiceDocumentBytes(eventId: string, versionId: string, client: Client = getPrisma()) {
  const document = await ensureInvoiceDocument(eventId, versionId, client);
  const attachment = await client.messageAttachment.findUniqueOrThrow({ where: { id: document.attachmentId }, select: { content: true, sha256: true, filename: true, contentType: true } });
  const actual = sha256Hex(attachment.content);
  if (actual !== document.sha256 || actual !== attachment.sha256) {
    throw new InvoiceError("The stored invoice PDF does not match its recorded hash, so it was not used. Tell a system administrator.", "DOCUMENT_CORRUPT");
  }
  return { bytes: attachment.content, sha256: actual, filename: attachment.filename, contentType: attachment.contentType, document };
}

/** For the download route: the PDF of any finalized version of this event, from the stored bytes. */
export async function getInvoicePdfForDownload(eventId: string, versionId: string) {
  return readInvoiceDocumentBytes(eventId, versionId);
}

// ---------------------------------------------------------------------------------------------
// Preview: exactly who would get it
// ---------------------------------------------------------------------------------------------

export type SendPreviewRecipient = RecipientCandidate;

export type DeliveryHistoryRecipient = {
  id: string;
  kind: "BILLING_CONTACT" | "CLUB_DIRECTOR";
  email: string;
  name: string | null;
  status: RecipientDeliveryStatus;
  problem: boolean;
  detail: string | null;
  at: string | null;
};

export type DeliveryHistoryEntry = {
  id: string;
  sequence: number;
  versionNumber: string;
  sentAt: string;
  sentByName: string;
  subject: string;
  contactChangedSinceFinalization: boolean;
  documentSha256: string;
  recipients: DeliveryHistoryRecipient[];
};

export type SendPreview = {
  eventId: string;
  invoiceId: string;
  version: { id: string; number: string; status: "FINALIZED" | "SUPERSEDED"; amountDueCents: number; organizationName: string; finalizedAt: string };
  /** False when the version cannot be sent (a revision replaced it). `blockedReason` says why. */
  canSend: boolean;
  blockedReason: string | null;
  /** When a newer finalized version exists: the one to send instead. */
  newerVersion: { id: string; number: string } | null;
  /** The contact the invoice (and its PDF) carries, and the billing contact now. */
  snapshotContact: InvoiceContact | null;
  currentContact: InvoiceContact | null;
  contactChanged: boolean;
  recipients: SendPreviewRecipient[];
  recipientsFingerprint: string;
  subject: string;
  body: string;
  sender: { name: string; email: string | null; replyTo: string | null };
  deliveryMode: "DISABLED" | "LOCAL_CAPTURE" | "EXTERNAL_EMAIL";
  pdf: { filename: string; exists: boolean; sha256: string | null };
  history: DeliveryHistoryEntry[];
  isResend: boolean;
};

async function currentBillingContact(client: Client, eventId: string, groupKey: string) {
  const billing = await getBillingResponsibilityView(eventId, {}, client);
  return contactOfGroup(billing.groups.find((candidate) => candidate.key === groupKey));
}

async function activeDirectors(client: Client, clubIds: readonly string[], now: Date) {
  if (clubIds.length === 0) return [];
  const grants = await client.clubDirectorGrant.findMany({
    where: { organizationId: { in: [...clubIds] }, role: "DIRECTOR", revokedAt: null },
    select: {
      effectiveFrom: true,
      effectiveTo: true,
      revokedAt: true,
      organizationId: true,
      organization: { select: { name: true } },
      attendeeAccount: { select: { id: true, email: true, displayName: true, disabledAt: true } },
    },
  });
  return grants
    .filter((grant) => directorGrantIsActive(grant, now) && grant.attendeeAccount.disabledAt === null)
    .map((grant) => ({ attendeeAccountId: grant.attendeeAccount.id, name: grant.attendeeAccount.displayName, email: grant.attendeeAccount.email, clubId: grant.organizationId, clubName: grant.organization.name }));
}

/** The latest invoice email to each address on this event, when it bounced, was suppressed, drew a complaint or failed. */
async function priorProblems(client: Client, eventId: string, emails: readonly string[]) {
  const problems = new Map<string, string>();
  if (emails.length === 0) return problems;
  const rows = await client.messageOutbox.findMany({
    where: { eventId, templateKey: "INVOICE_DELIVERY", recipientEmail: { in: [...emails] } },
    orderBy: { createdAt: "desc" },
    select: { recipientEmail: true, status: true, providerDeliveryStatus: true },
  });
  const seen = new Set<string>();
  for (const row of rows) {
    const email = row.recipientEmail.toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    const status = recipientDeliveryStatus(row);
    if (isDeliveryProblem(status)) {
      problems.set(email, status === "BOUNCED" ? "The last invoice email to this address bounced." : status === "COMPLAINED" ? "The last invoice email to this address was marked as spam." : status === "SUPPRESSED" ? "The last invoice email to this address was not sent (suppressed)." : "The last invoice email to this address failed.");
    }
  }
  return problems;
}

type RecipientCandidateInputs = {
  eventId: string;
  version: { id: string; invoiceId: string; snapshot: unknown; contactName: string | null; contactEmail: string | null; contactRoleLabel: string | null; contactVerified: boolean };
  invoice: { groupKey: string; clubId: string | null };
};

/** The recipient list the server would send to now. Used by the preview and again, from scratch, by the send. */
async function computeRecipients(client: Client, input: RecipientCandidateInputs, now: Date) {
  const snapshot = input.version.snapshot as InvoiceSnapshot;
  const clubIds = [...new Set([...(input.invoice.clubId ? [input.invoice.clubId] : []), ...snapshot.lines.flatMap((line) => (line.clubId ? [line.clubId] : []))])];
  const [currentContact, directors] = await Promise.all([currentBillingContact(client, input.eventId, input.invoice.groupKey), activeDirectors(client, clubIds, now)]);
  const emails = [...(currentContact ? [currentContact.email.trim().toLowerCase()] : []), ...directors.map((director) => director.email.trim().toLowerCase())];
  const problems = await priorProblems(client, input.eventId, emails);
  const candidates = buildRecipientCandidates({ billingContact: currentContact, directors, problems });
  const snapshotContact: InvoiceContact | null = input.version.contactName && input.version.contactEmail
    ? { name: input.version.contactName, email: input.version.contactEmail, roleLabel: input.version.contactRoleLabel ?? "", verified: input.version.contactVerified }
    : null;
  const contactChanged = !contactsMatch(snapshotContact ? { name: snapshotContact.name, email: snapshotContact.email } : null, currentContact ? { name: currentContact.name, email: currentContact.email } : null);
  return { candidates, currentContact, snapshotContact, contactChanged };
}

const versionForSendSelect = {
  id: true,
  invoiceId: true,
  status: true,
  number: true,
  revision: true,
  amountDueCents: true,
  organizationName: true,
  finalizedAt: true,
  snapshot: true,
  contactName: true,
  contactEmail: true,
  contactRoleLabel: true,
  contactVerified: true,
  supersedesVersionId: true,
  invoice: { select: { groupKey: true, clubId: true, baseNumber: true } },
  event: { select: { name: true } },
} satisfies Prisma.InvoiceVersionSelect;

export async function getInvoiceDeliveryHistory(eventId: string, invoiceId: string, client: Client = getPrisma()): Promise<DeliveryHistoryEntry[]> {
  const rows = await client.invoiceDelivery.findMany({
    where: { eventId, invoiceId },
    orderBy: [{ createdAt: "desc" }, { sequence: "desc" }],
    select: {
      id: true,
      sequence: true,
      createdAt: true,
      sentByName: true,
      subject: true,
      contactChangedSinceFinalization: true,
      invoiceVersion: { select: { number: true } },
      document: { select: { sha256: true } },
      recipients: {
        orderBy: { createdAt: "asc" },
        select: { id: true, kind: true, message: { select: { recipientEmail: true, recipientName: true, status: true, providerDeliveryStatus: true, lastError: true, sentAt: true, capturedAt: true, failedAt: true, providerStatusAt: true } } },
      },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    sequence: row.sequence,
    versionNumber: row.invoiceVersion.number ?? "",
    sentAt: row.createdAt.toISOString(),
    sentByName: row.sentByName,
    subject: row.subject,
    contactChangedSinceFinalization: row.contactChangedSinceFinalization,
    documentSha256: row.document.sha256,
    recipients: row.recipients.map((recipient) => {
      const status = recipientDeliveryStatus(recipient.message);
      return {
        id: recipient.id,
        kind: recipient.kind,
        email: recipient.message.recipientEmail,
        name: recipient.message.recipientName,
        status,
        problem: isDeliveryProblem(status),
        detail: recipient.message.lastError,
        at: (recipient.message.providerStatusAt ?? recipient.message.sentAt ?? recipient.message.capturedAt ?? recipient.message.failedAt)?.toISOString() ?? null,
      };
    }),
  }));
}

/**
 * What staff see before sending: the version, the exact recipients (each untickable), the editable subject and
 * body, whether the contact changed since finalization, any newer version, and the sends so far. Reading it sends
 * nothing and (for a version that has no PDF yet) makes the PDF, which is the same document every later send uses.
 */
export async function getInvoiceSendPreview(eventId: string, versionId: string): Promise<SendPreview> {
  const prisma = getPrisma();
  const version = await prisma.invoiceVersion.findFirst({ where: { id: versionId, eventId }, select: versionForSendSelect });
  if (!version || (version.status !== "FINALIZED" && version.status !== "SUPERSEDED") || !version.number || !version.finalizedAt) {
    throw new InvoiceError("That invoice version does not belong to this event, or is not finalized.", "VERSION_NOT_FOUND");
  }
  await ensureEventMessagingDefaults(eventId);
  const [settings, newer, history, document, prior] = await Promise.all([
    prisma.eventMessageSettings.findUniqueOrThrow({ where: { eventId }, select: { deliveryMode: true, senderName: true, senderEmail: true, replyToEmail: true } }),
    version.status === "SUPERSEDED"
      ? prisma.invoiceVersion.findFirst({ where: { invoiceId: version.invoiceId, status: "FINALIZED" }, select: { id: true, number: true } })
      : Promise.resolve(null),
    getInvoiceDeliveryHistory(eventId, version.invoiceId, prisma),
    ensureInvoiceDocument(eventId, version.id, prisma),
    version.supersedesVersionId ? prisma.invoiceVersion.findUnique({ where: { id: version.supersedesVersionId }, select: { number: true } }) : Promise.resolve(null),
  ]);
  const { candidates, currentContact, snapshotContact, contactChanged } = await computeRecipients(prisma, { eventId, version, invoice: version.invoice }, new Date());
  const superseded = version.status === "SUPERSEDED";
  const documentRow = await prisma.invoiceVersionDocument.findUniqueOrThrow({ where: { id: document.id }, select: { paymentInstructions: true } });
  return {
    eventId,
    invoiceId: version.invoiceId,
    version: { id: version.id, number: version.number, status: version.status, amountDueCents: version.amountDueCents, organizationName: version.organizationName, finalizedAt: version.finalizedAt.toISOString() },
    canSend: !superseded,
    blockedReason: superseded
      ? newer ? `This version was replaced by ${newer.number}. A replaced version cannot be sent; send the newer one.` : "This version was replaced. A replaced version cannot be sent."
      : null,
    newerVersion: newer?.number ? { id: newer.id, number: newer.number } : null,
    snapshotContact,
    currentContact,
    contactChanged,
    recipients: candidates,
    recipientsFingerprint: recipientsFingerprint(candidates),
    subject: defaultInvoiceSubject({ number: version.number, organizationName: version.organizationName, eventName: version.event.name }),
    body: defaultInvoiceBody({
      number: version.number,
      organizationName: version.organizationName,
      eventName: version.event.name,
      amountLabel: formatPdfMoney(version.amountDueCents),
      filename: document.filename,
      paymentInstructions: documentRow.paymentInstructions,
      senderName: settings.senderName,
      supersedesNumber: prior?.number ?? null,
    }),
    sender: { name: settings.senderName, email: settings.senderEmail, replyTo: settings.replyToEmail },
    deliveryMode: settings.deliveryMode,
    pdf: { filename: document.filename, exists: true, sha256: document.sha256 },
    history,
    isResend: history.some((entry) => entry.versionNumber === version.number),
  };
}

// ---------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------

export type SendInvoiceResult = {
  deliveryId: string;
  sequence: number;
  versionId: string;
  number: string;
  replayed: boolean;
  deliveryMode: "DISABLED" | "LOCAL_CAPTURE" | "EXTERNAL_EMAIL";
  recipientCount: number;
  documentSha256: string;
  /** Outbox status counts after the send: how many were queued, captured locally, sent or suppressed. */
  outcome: { suppressed: number; captured: number; sent: number; queued: number; failed: number };
};

/**
 * Sends (or resends) a finalized version: queues one outbox message per ticked recipient, each with the version's
 * stored PDF attached, and records the delivery. Staff action only (the route checks MANAGE_FINANCE). The recipient
 * list is recomputed here from billing responsibility and the club directors, never taken from the caller: the
 * caller names which of those it was shown stay ticked, and the fingerprint of what it was shown must still match.
 */
export async function sendInvoiceVersion(input: {
  eventId: string;
  versionId: string;
  actorUserId: string;
  selectedKeys: readonly string[];
  recipientsFingerprint: string;
  subject: string;
  body: string;
  idempotencyKey: string;
  confirm: boolean;
}): Promise<SendInvoiceResult> {
  if (!input.confirm) throw new InvoiceError("Confirm that you are sending this invoice.", "CONFIRMATION_REQUIRED");
  const message = sendMessageSchema.safeParse({ subject: input.subject, body: input.body });
  if (!message.success) throw new InvoiceError(message.error.issues[0]?.message ?? "Check the message.", "INVALID_INPUT");
  const subject = message.data.subject;
  const bodyText = neutralizePlaceholders(message.data.body);
  const prisma = getPrisma();
  await ensureEventMessagingDefaults(input.eventId);

  // The PDF exists before the send transaction (it is created once, from the snapshot); the transaction checks the version again.
  const document = await ensureInvoiceDocument(input.eventId, input.versionId, prisma);
  await readInvoiceDocumentBytes(input.eventId, input.versionId, prisma);
  if (document.sizeBytes > MAX_ATTACHMENT_BYTES) {
    throw new InvoiceError(`The invoice PDF is ${(document.sizeBytes / 1024 / 1024).toFixed(1)} MB, over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit for an email attachment, so it was not sent.`, "INVALID_INPUT");
  }

  const finish = async (deliveryId: string, replayed: boolean): Promise<SendInvoiceResult> => {
    const delivery = await prisma.invoiceDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
      select: { id: true, sequence: true, invoiceVersionId: true, invoiceVersion: { select: { number: true } }, document: { select: { sha256: true } }, recipients: { select: { message: { select: { id: true, status: true, eventId: true } } } } },
    });
    return finishDelivery(delivery, replayed);
  };
  const finishDelivery = async (
    delivery: { id: string; sequence: number; invoiceVersionId: string; invoiceVersion: { number: string | null }; document: { sha256: string }; recipients: Array<{ message: { id: string; status: string } }> },
    replayed: boolean,
  ): Promise<SendInvoiceResult> => {
    const settings = await prisma.eventMessageSettings.findUniqueOrThrow({ where: { eventId: input.eventId }, select: { deliveryMode: true } });
    if (!replayed) {
      // After the commit, never inside it: a delivery failure leaves the rows queued for the sweep and the record intact.
      try {
        await processQueuedMessageIdsAfterCommit(delivery.recipients.filter((recipient) => recipient.message.status === "PENDING").map((recipient) => recipient.message.id));
      } catch (error) {
        logError("An invoice email could not be delivered right now; it stays queued.", error, { deliveryId: delivery.id });
      }
    }
    const rows = await prisma.messageOutbox.findMany({ where: { id: { in: delivery.recipients.map((recipient) => recipient.message.id) } }, select: { status: true, providerDeliveryStatus: true } });
    const outcome = { suppressed: 0, captured: 0, sent: 0, queued: 0, failed: 0 };
    for (const row of rows) {
      const status = recipientDeliveryStatus(row);
      if (status === "SUPPRESSED") outcome.suppressed += 1;
      else if (status === "CAPTURED") outcome.captured += 1;
      else if (status === "SENT" || status === "DELIVERED") outcome.sent += 1;
      else if (status === "QUEUED") outcome.queued += 1;
      else outcome.failed += 1;
    }
    return { deliveryId: delivery.id, sequence: delivery.sequence, versionId: delivery.invoiceVersionId, number: delivery.invoiceVersion.number ?? "", replayed, deliveryMode: settings.deliveryMode, recipientCount: delivery.recipients.length, documentSha256: delivery.document.sha256, outcome };
  };

  let created: { id: string; sequence: number; invoiceVersionId: string; invoiceVersion: { number: string | null }; document: { sha256: string }; recipients: Array<{ message: { id: string; status: string } }> } | null;
  try {
    created = await prisma.$transaction(async (tx) => {
      await lockEvent(tx, input.eventId);
      const replayed = await tx.invoiceDelivery.findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { id: true, invoiceVersionId: true, eventId: true } });
      if (replayed) {
        if (replayed.invoiceVersionId !== input.versionId || replayed.eventId !== input.eventId) throw new InvoiceError("That request key was already used for a different send. Reload the page and try again.", "IDEMPOTENCY_KEY_REUSED");
        return null;
      }
      const version = await tx.invoiceVersion.findFirst({ where: { id: input.versionId, eventId: input.eventId }, select: versionForSendSelect });
      if (!version || !version.number) throw new InvoiceError("That invoice version does not belong to this event.", "VERSION_NOT_FOUND");
      if (version.status !== "FINALIZED") {
        throw new InvoiceError(version.status === "SUPERSEDED" ? "That version was replaced by a newer one and cannot be sent. Send the newer version." : "Only a finalized invoice can be sent.", "NOT_SENDABLE");
      }
      const settings = await tx.eventMessageSettings.findUniqueOrThrow({ where: { eventId: input.eventId } });
      if (settings.deliveryMode === "EXTERNAL_EMAIL" && !settings.senderEmail?.trim()) {
        throw new InvoiceError("Add a verified sender email in this event's communication settings before sending real email.", "EXTERNAL_EMAIL_NOT_CONFIGURED");
      }
      const { candidates, contactChanged } = await computeRecipients(tx, { eventId: input.eventId, version, invoice: version.invoice }, new Date());
      if (recipientsFingerprint(candidates) !== input.recipientsFingerprint) {
        throw new InvoiceError("The recipients changed since you opened this page (a contact or director was updated). Reload to see the current list.", "PREVIEW_CHANGED");
      }
      const selection = selectRecipients(candidates, input.selectedKeys);
      if (!selection.ok) {
        throw new InvoiceError(
          selection.issue === "NONE_SELECTED" ? "Choose at least one recipient." : "A chosen recipient is not on the current list. Reload the page and choose again.",
          selection.issue === "NONE_SELECTED" ? "NO_RECIPIENTS" : "UNKNOWN_RECIPIENT",
        );
      }
      const actor = await tx.user.findUniqueOrThrow({ where: { id: input.actorUserId }, select: { displayName: true } });
      const previousSends = await tx.invoiceDelivery.count({ where: { invoiceVersionId: version.id } });
      const sequence = previousSends + 1;
      const suppressed = settings.deliveryMode === "DISABLED";
      const bodyHtml = renderEmailBodyHtml(escapeMarkdown(bodyText));
      const delivery = await tx.invoiceDelivery.create({
        data: {
          eventId: input.eventId,
          invoiceId: version.invoiceId,
          invoiceVersionId: version.id,
          documentId: document.id,
          sequence,
          sentByUserId: input.actorUserId,
          sentByName: actor.displayName,
          subject,
          contactChangedSinceFinalization: contactChanged,
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true },
      });
      const messageIds: string[] = [];
      for (const recipient of selection.selected) {
        const outbox = await tx.messageOutbox.create({
          data: {
            eventId: input.eventId,
            templateKey: "INVOICE_DELIVERY",
            recipientKind: recipient.kind === "CLUB_DIRECTOR" ? "CLUB_DIRECTOR" : "BILLING_CONTACT",
            recipientEmail: recipient.email,
            recipientName: recipient.name,
            senderNameSnapshot: settings.senderName,
            senderEmailSnapshot: settings.senderEmail,
            replyToEmailSnapshot: settings.replyToEmail,
            subjectSnapshot: subject,
            bodyTextSnapshot: bodyText,
            bodyHtmlSnapshot: bodyHtml,
            attachmentId: document.attachmentId,
            metadata: {
              trigger: "INVOICE_DELIVERY",
              invoiceId: version.invoiceId,
              versionId: version.id,
              deliveryId: delivery.id,
              sequence,
              recipientKind: recipient.kind,
              deliveryMode: settings.deliveryMode,
              realDelivery: settings.deliveryMode === "EXTERNAL_EMAIL",
            },
            idempotencyKey: `invoice-delivery:${delivery.id}:${recipient.key}`,
            correlationId: randomUUID(),
            status: suppressed ? "SUPPRESSED" : "PENDING",
            lastError: suppressed ? "Delivery is disabled for this event." : null,
          },
          select: { id: true },
        });
        await tx.invoiceDeliveryRecipient.create({ data: { deliveryId: delivery.id, kind: recipient.kind, attendeeAccountId: recipient.attendeeAccountId, clubId: recipient.clubIds[0] ?? null, messageOutboxId: outbox.id } });
        messageIds.push(outbox.id);
      }
      await writeAuditLog({
        eventId: input.eventId,
        actorUserId: input.actorUserId,
        action: sequence === 1 ? "INVOICE_SENT" : "INVOICE_RESENT",
        entityType: "InvoiceDelivery",
        entityId: delivery.id,
        summary: `${sequence === 1 ? "Sent" : "Resent"} invoice ${version.number} to ${selection.selected.length} recipient${selection.selected.length === 1 ? "" : "s"}.`,
        metadata: {
          eventId: input.eventId,
          invoiceId: version.invoiceId,
          versionId: version.id,
          deliveryId: delivery.id,
          number: version.number,
          sequence,
          recipientCount: selection.selected.length,
          billingContactIncluded: selection.selected.some((recipient) => recipient.kind === "BILLING_CONTACT"),
          directorCount: selection.selected.filter((recipient) => recipient.kind === "CLUB_DIRECTOR").length,
          unticked: candidates.length - selection.selected.length,
          messageIds,
          documentSha256: document.sha256,
          deliveryMode: settings.deliveryMode,
          contactChangedSinceFinalization: contactChanged,
        },
      }, tx);
      return {
        id: delivery.id,
        sequence,
        invoiceVersionId: version.id,
        invoiceVersion: { number: version.number },
        document: { sha256: document.sha256 },
        recipients: messageIds.map((id) => ({ message: { id, status: suppressed ? "SUPPRESSED" : "PENDING" } })),
      };
    }, { timeout: 30_000, maxWait: 10_000 });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await prisma.invoiceDelivery.findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { id: true, invoiceVersionId: true } });
      if (again && again.invoiceVersionId === input.versionId) return finish(again.id, true);
      throw new InvoiceError("Someone else just sent this invoice. Reload to see the history before sending again.", "CONCURRENT_CHANGE");
    }
    throw error;
  }
  if (created === null) {
    const replay = await prisma.invoiceDelivery.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey }, select: { id: true } });
    return finish(replay.id, true);
  }
  return finishDelivery(created, false);
}
