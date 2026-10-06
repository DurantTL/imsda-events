import "server-only";

import { getPrisma } from "@/lib/prisma";
import type { Client } from "@/modules/lodging/preferences-service";
import { isOfferLapsed, type WaitlistStatus } from "@/modules/lodging/assignment-domain";
import { loadRegistrantStays, registrationAssignmentVersion } from "@/modules/lodging/registrant-stays";
import { noticeContentHash } from "@/modules/lodging/stays";

/**
 * Checked again immediately before a lodging email goes out (the way an invoice email is checked against its version):
 * a room notice that a later change made wrong, or a waitlist offer that is no longer open, is cancelled, never sent.
 * Returns the reason to cancel, or null when the message is still right.
 */
export async function lodgingMessageStaleReason(messageId: string, templateKey: string, now = new Date(), client: Client = getPrisma()): Promise<string | null> {
  if (templateKey !== "LODGING_ASSIGNMENT_NOTICE" && templateKey !== "LODGING_WAITLIST_OFFER") return null;
  const prisma = client;
  if (templateKey === "LODGING_ASSIGNMENT_NOTICE") {
    const notice = await prisma.eventLodgingAssignmentNotice.findFirst({ where: { outboxMessageId: messageId } });
    if (!notice) return null;
    const newer = await prisma.eventLodgingAssignmentNotice.count({ where: { eventId: notice.eventId, registrationId: notice.registrationId, createdAt: { gt: notice.createdAt } } });
    if (newer > 0) return "A newer room notice replaced this one before it was sent.";
    const stays = await loadRegistrantStays(prisma, notice.eventId, notice.registrationId);
    if (!stays.published || !stays.active) return "Room assignments are no longer shown to this registration, so this notice was not sent.";
    const version = await registrationAssignmentVersion(prisma, notice.eventId, notice.registrationId);
    if (version !== notice.assignmentVersion || noticeContentHash(stays.stays, stays.instructions, stays.published) !== notice.contentHash) {
      return "A later room change made this notice out of date before it was sent.";
    }
    return null;
  }
  const message = await prisma.messageOutbox.findUnique({ where: { id: messageId }, select: { metadata: true } });
  const metadata = message?.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata) ? message.metadata as Record<string, unknown> : {};
  if (typeof metadata.waitlistEntryId !== "string" || typeof metadata.offerNumber !== "number") return null;
  const entry = await prisma.eventLodgingWaitlistEntry.findUnique({ where: { id: metadata.waitlistEntryId } });
  if (!entry || entry.status !== "OFFERED" || entry.offerNumber !== metadata.offerNumber || isOfferLapsed({ status: entry.status as WaitlistStatus, offerExpiresAt: entry.offerExpiresAt }, now)) {
    return "This lodging offer is no longer open, so it was not sent.";
  }
  return null;
}
