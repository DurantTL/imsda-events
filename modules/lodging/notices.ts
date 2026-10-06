import "server-only";

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { REGISTRATION_MANAGE_LINK_SENTINEL } from "@/modules/communications/manage-link";
import { escapeMarkdown, renderEmailBodyHtml } from "@/modules/communications/email-html";
import { processQueuedMessageIdsAfterCommit } from "@/modules/communications/messaging-repository";
import { loadRegistrantStays, registrationAssignmentVersion } from "@/modules/lodging/registrant-stays";
import { noticeContentHash } from "@/modules/lodging/stays";
import { LodgingError } from "@/modules/lodging/errors";
import { lodgingTransactionTimeoutMs } from "@/modules/lodging/service";
import type { Client, Tx } from "@/modules/lodging/preferences-service";

/**
 * Lodging email (#200): a waitlist offer and a room notice. Both are written to the existing transactional outbox
 * (`MessageOutbox`), one registration at a time, and only from an explicit staff action: nothing here ever runs on its
 * own, and there is no bulk send. They are not editable event templates (like the invoice email, the wording is fixed
 * and built from facts), they use the event's sender and delivery mode, are suppressed when delivery is disabled, carry
 * the private-link sentinel (a fresh link is minted at delivery, never stored), and have a deterministic idempotency
 * key so a repeated click cannot queue the same message twice. Nothing here prices, charges or refunds anything.
 */

export type LodgingMessageKey = "LODGING_WAITLIST_OFFER" | "LODGING_ASSIGNMENT_NOTICE";

export type LodgingMessageContent = {
  heading: string;
  /** Plain sentences; written into the text part as they are and escaped for the HTML part. */
  paragraphs: string[];
  bullets?: string[];
  linkLabel: string;
};

function renderLodgingMessage(content: LodgingMessageContent, recipientName: string) {
  const greeting = `Hello ${recipientName || "there"},`;
  const text = [
    content.heading,
    "",
    greeting,
    "",
    ...content.paragraphs.flatMap((paragraph) => [paragraph, ""]),
    ...(content.bullets?.length ? [...content.bullets.map((bullet) => `- ${bullet}`), ""] : []),
    `${content.linkLabel}: ${REGISTRATION_MANAGE_LINK_SENTINEL}`,
  ].join("\n");
  const markdown = [
    `# ${escapeMarkdown(content.heading)}`,
    "",
    escapeMarkdown(greeting),
    "",
    ...content.paragraphs.flatMap((paragraph) => [escapeMarkdown(paragraph), ""]),
    ...(content.bullets?.length ? [...content.bullets.map((bullet) => `- ${escapeMarkdown(bullet)}`), ""] : []),
    `**[${escapeMarkdown(content.linkLabel)}](${REGISTRATION_MANAGE_LINK_SENTINEL})**`,
  ].join("\n");
  return { text, html: renderEmailBodyHtml(markdown) };
}

/** `j***@example.org`: enough for staff to recognise a destination in a preview, not enough to copy. */
export function maskEmail(email: string) {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

export type EnqueuedLodgingMessage = { messageId: string | null; pending: boolean; skipped: "NO_RECIPIENT" | "NO_REGISTRATION" | null; recipientMasked: string | null };

export async function lodgingRecipient(client: Client, eventId: string, registrationId: string) {
  const registration = await client.registration.findFirst({
    where: { id: registrationId, eventId },
    select: { confirmationCode: true, contactSnapshot: true, accountHolderPerson: { select: { firstName: true, lastName: true, normalizedEmail: true } }, event: { select: { name: true, timezone: true } } },
  });
  if (!registration) return null;
  const contact = registration.contactSnapshot && typeof registration.contactSnapshot === "object" && !Array.isArray(registration.contactSnapshot) ? registration.contactSnapshot as Record<string, unknown> : {};
  const snapshotText = (key: string) => (typeof contact[key] === "string" ? (contact[key] as string).trim() : "");
  const email = (snapshotText("email") || registration.accountHolderPerson.normalizedEmail || "").trim().toLowerCase();
  const name = `${snapshotText("firstName") || registration.accountHolderPerson.firstName} ${snapshotText("lastName") || registration.accountHolderPerson.lastName}`.trim();
  return { email, name, confirmationCode: registration.confirmationCode, eventName: registration.event.name, timezone: registration.event.timezone };
}

/** Writes one outbox row for one registration. Call inside the transaction of the staff action; process after it commits. */
export async function enqueueLodgingMessage(tx: Tx, input: {
  eventId: string;
  registrationId: string;
  templateKey: LodgingMessageKey;
  subject: string;
  content: LodgingMessageContent;
  idempotencyKey: string;
  metadata: Record<string, string | number | boolean | null>;
}): Promise<EnqueuedLodgingMessage> {
  const [settingsRow, recipient] = await Promise.all([
    tx.eventMessageSettings.findUnique({ where: { eventId: input.eventId }, select: { deliveryMode: true, senderName: true, senderEmail: true, replyToEmail: true } }),
    lodgingRecipient(tx, input.eventId, input.registrationId),
  ]);
  if (!recipient) return { messageId: null, pending: false, skipped: "NO_REGISTRATION", recipientMasked: null };
  if (!recipient.email) return { messageId: null, pending: false, skipped: "NO_RECIPIENT", recipientMasked: null };
  const settings = settingsRow ?? { deliveryMode: "LOCAL_CAPTURE" as const, senderName: "IMSDA Events", senderEmail: null, replyToEmail: null };
  const rendered = renderLodgingMessage(input.content, recipient.name);
  const suppressed = settings.deliveryMode === "DISABLED";
  const message = await tx.messageOutbox.upsert({
    where: { idempotencyKey: input.idempotencyKey },
    update: {},
    create: {
      eventId: input.eventId,
      registrationId: input.registrationId,
      templateKey: input.templateKey,
      recipientKind: "REGISTRANT",
      recipientEmail: recipient.email,
      recipientName: recipient.name,
      senderNameSnapshot: settings.senderName,
      senderEmailSnapshot: settings.senderEmail,
      replyToEmailSnapshot: settings.replyToEmail,
      subjectSnapshot: input.subject,
      bodyTextSnapshot: rendered.text,
      bodyHtmlSnapshot: rendered.html,
      metadata: { trigger: input.templateKey, deliveryMode: settings.deliveryMode, realDelivery: settings.deliveryMode === "EXTERNAL_EMAIL", confirmationCode: recipient.confirmationCode, ...input.metadata },
      idempotencyKey: input.idempotencyKey,
      correlationId: randomUUID(),
      status: suppressed ? "SUPPRESSED" : "PENDING",
      lastError: suppressed ? "Delivery is disabled for this event." : null,
    },
    select: { id: true, status: true },
  });
  return { messageId: message.id, pending: message.status === "PENDING", skipped: null, recipientMasked: maskEmail(recipient.email) };
}

/** Delivery runs after the transaction commits and never rolls a committed action back. */
export async function deliverAfterCommit(messageIds: readonly string[]) {
  if (messageIds.length === 0) return;
  try {
    await processQueuedMessageIdsAfterCommit([...messageIds]);
  } catch (error) {
    logError("A lodging email could not be delivered right now; it stays queued.", error);
  }
}

// ---------------------------------------------------------------------------
// Room notices
// ---------------------------------------------------------------------------

const nightWords = (first: string, last: string) => (first === last ? `the night of ${first}` : `the nights ${first} to ${last}`);

export { registrationAssignmentVersion };

export type RoomNoticeResult = { noticeId: string; messageId: string | null; assignmentVersion: number; alreadySent: boolean; skipped: EnqueuedLodgingMessage["skipped"] };

/**
 * One explicit staff action sends one registration its room notice. It requires that staff published assignments for
 * the event (the notice shows exactly what the private page shows, roommates by first name only when that is on).
 * It is versioned: the notice records the assignment version it described, a later change makes it obsolete (a notice
 * not yet delivered is cancelled by the change), and sending again at an unchanged version queues nothing new.
 */
export async function sendRoomNotice(eventId: string, actorUserId: string, registrationId: string, client: PrismaClient = getPrisma()): Promise<RoomNoticeResult> {
  const result = await client.$transaction(async (tx) => {
    const lodging = await tx.eventLodging.findUnique({ where: { eventId }, select: { showAssignmentsToAttendees: true } });
    if (!lodging) throw new LodgingError("NO_PROPERTY", "This event has no lodging set up.");
    if (!lodging.showAssignmentsToAttendees) throw new LodgingError("NOT_PUBLISHED", "Show room assignments to attendees first. A room notice says what the private page says.");
    const registration = await tx.registration.findFirst({ where: { id: registrationId, eventId, status: { in: ["SUBMITTED", "CONFIRMED"] } }, select: { id: true } });
    if (!registration) throw new LodgingError("REGISTRATION_NOT_FOUND", "That registration was not found, or it is not active.");
    const view = await loadRegistrantStays(tx, eventId, registrationId);
    if (view.stays.length === 0) throw new LodgingError("ASSIGNMENT_NOT_FOUND", "Nobody on that registration has a room yet.");
    const version = await registrationAssignmentVersion(tx, eventId, registrationId);
    // What the notice would say: it is current only while this (and the assignment version) still match.
    const contentHash = noticeContentHash(view.stays, view.instructions, view.published);
    const existing = await tx.eventLodgingAssignmentNotice.findFirst({ where: { eventId, registrationId, assignmentVersion: version, contentHash }, orderBy: { createdAt: "desc" } });
    if (existing) return { noticeId: existing.id, messageId: existing.outboxMessageId, assignmentVersion: version, alreadySent: true, skipped: null as EnqueuedLodgingMessage["skipped"] };
    const recipient = await lodgingRecipient(tx, eventId, registrationId);
    const bullets = view.stays.map((stay) => {
      const where = stay.kind === "ROOM" ? `${stay.building ? `${stay.building}, ` : ""}${stay.room}` : `${stay.room} (arranged outside the property)`;
      const mates = stay.roommates.length > 0 ? `. Staying with: ${stay.roommates.join(", ")}${stay.otherGuests > 0 ? ` and ${stay.otherGuests} other${stay.otherGuests === 1 ? "" : "s"}` : ""}` : "";
      return `${stay.name}: ${where}, ${nightWords(stay.firstNight, stay.lastNight)}${mates}`;
    });
    const enqueued = await enqueueLodgingMessage(tx, {
      eventId, registrationId, templateKey: "LODGING_ASSIGNMENT_NOTICE",
      subject: `Your room for ${recipient?.eventName ?? "the event"}`,
      content: {
        heading: `Your room for ${recipient?.eventName ?? "the event"}`,
        paragraphs: [
          "Here is where each person on your registration is staying.",
          ...(view.instructions ? [view.instructions] : []),
          "Rooms can change. Your private registration page always shows the latest.",
        ],
        bullets,
        linkLabel: "Open your private registration page",
      },
      idempotencyKey: `lodging-notice:${registrationId}:${version}:${contentHash.slice(0, 16)}`,
      metadata: { assignmentVersion: version },
    });
    const notice = await tx.eventLodgingAssignmentNotice.create({ data: { eventId, registrationId, outboxMessageId: enqueued.messageId, assignmentVersion: version, contentHash, sentByUserId: actorUserId } });
    await writeAuditLog({
      eventId, actorUserId, action: "LODGING_ROOM_NOTICE_QUEUED", entityType: "EventLodgingAssignmentNotice", entityId: notice.id,
      summary: enqueued.skipped ? "A room notice could not be queued (no email address on the registration)." : "Queued a room notice for one registration.",
      metadata: { assignmentVersion: version, skipped: enqueued.skipped },
    }, tx);
    return { noticeId: notice.id, messageId: enqueued.messageId, assignmentVersion: version, alreadySent: false, skipped: enqueued.skipped, pending: enqueued.pending };
  }, { timeout: lodgingTransactionTimeoutMs });
  if ("pending" in result && result.pending && result.messageId) await deliverAfterCommit([result.messageId]);
  return { noticeId: result.noticeId, messageId: result.messageId, assignmentVersion: result.assignmentVersion, alreadySent: result.alreadySent, skipped: result.skipped };
}
