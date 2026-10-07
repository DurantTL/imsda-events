import { createHash } from "node:crypto";
import { attachmentSetIssue } from "@/modules/communications/message-file-rules";
import type { AnnouncementBroadcastPreview, MessagingSettingsRecord } from "@/modules/communications/types";

/**
 * The pure half of the announcement broadcast review (#472).
 *
 * The preview must count exactly who the send will reach, so it resolves each
 * recipient the way `enqueueTransactionalMessage` does: the contact snapshot's
 * email, falling back to the account holder's normalized email, trimmed and
 * lowercased. A registration with neither is skipped by the send
 * (NO_RECIPIENT), so the review counts it as skipped rather than as a
 * recipient. A disabled EVENT_ANNOUNCEMENT template or a disabled delivery
 * mode writes every message as SUPPRESSED, which the review reports too.
 *
 * The fingerprint follows the selected-audience pattern (#332): the send
 * recomputes it inside its transaction and refuses when anything that changes
 * who receives what has moved since the review.
 */

export type AnnouncementBroadcastCandidate = {
  registrationId: string;
  contactSnapshot: unknown;
  accountHolderNormalizedEmail: string | null;
};

export type AnnouncementBroadcastPreviewContext = {
  eventId: string;
  announcement: { id: string; title: string; body: string };
  deliveryMode: MessagingSettingsRecord["deliveryMode"];
  templateEnabled: boolean;
  templateVersionId: string | null;
  /** Every file each email carries (#824): announcement's own first, then the template version's. */
  attachments?: ReadonlyArray<{ id: string; filename: string; sizeBytes: number }>;
};

export const ANNOUNCEMENT_BROADCAST_AUDIENCE_LABEL =
  "All active registrations (submitted or confirmed) for this event";

/** Mirrors the recipient-email rule in `enqueueTransactionalMessage`. */
export function announcementRecipientEmail(
  contactSnapshot: unknown,
  accountHolderNormalizedEmail: string | null,
) {
  const contact = contactSnapshot && typeof contactSnapshot === "object" && !Array.isArray(contactSnapshot)
    ? contactSnapshot as Record<string, unknown>
    : {};
  const snapshotEmail = typeof contact.email === "string" && contact.email.trim()
    ? contact.email.trim()
    : "";
  return (snapshotEmail || accountHolderNormalizedEmail || "").trim().toLowerCase();
}

export type AnnouncementBroadcastRecipient = {
  registrationId: string;
  recipientEmail: string;
};

/**
 * The single recipient rule for an announcement broadcast. The preview counts
 * and fingerprints this list, and the send enqueues exactly this list with
 * each resolved email, so what staff reviewed is what goes out.
 */
export function resolveAnnouncementBroadcastAudience(
  candidates: readonly AnnouncementBroadcastCandidate[],
) {
  const recipients: AnnouncementBroadcastRecipient[] = [];
  const skippedRegistrationIds: string[] = [];
  const ordered = [...candidates].sort((a, b) => a.registrationId.localeCompare(b.registrationId));
  for (const candidate of ordered) {
    const recipientEmail = announcementRecipientEmail(
      candidate.contactSnapshot,
      candidate.accountHolderNormalizedEmail,
    );
    if (recipientEmail) {
      recipients.push({ registrationId: candidate.registrationId, recipientEmail });
    } else {
      skippedRegistrationIds.push(candidate.registrationId);
    }
  }
  return { recipients, skippedRegistrationIds };
}

export function computeAnnouncementBroadcastPreview(
  candidates: readonly AnnouncementBroadcastCandidate[],
  context: AnnouncementBroadcastPreviewContext,
  now = new Date(),
): AnnouncementBroadcastPreview {
  const { recipients, skippedRegistrationIds } = resolveAnnouncementBroadcastAudience(candidates);
  const attachments = context.attachments ?? [];

  const fingerprint = createHash("sha256").update(JSON.stringify({
    version: 1,
    eventId: context.eventId,
    announcementId: context.announcement.id,
    announcementTitle: context.announcement.title,
    announcementBody: context.announcement.body,
    deliveryMode: context.deliveryMode,
    templateEnabled: context.templateEnabled,
    templateVersionId: context.templateVersionId,
    attachments: attachments.map((file) => file.id),
    recipients,
    skippedRegistrationIds,
  })).digest("hex");

  return {
    announcementId: context.announcement.id,
    title: context.announcement.title,
    audienceLabel: ANNOUNCEMENT_BROADCAST_AUDIENCE_LABEL,
    activeRegistrationCount: candidates.length,
    recipientCount: recipients.length,
    skippedNoEmailCount: skippedRegistrationIds.length,
    deliveryMode: context.deliveryMode,
    templateEnabled: context.templateEnabled,
    suppressed: context.deliveryMode === "DISABLED" || !context.templateEnabled,
    attachments: attachments.map((file) => ({ filename: file.filename, sizeBytes: file.sizeBytes })),
    attachmentProblem: attachmentSetIssue(attachments)?.message ?? null,
    fingerprint,
    sendTiming: "IMMEDIATE",
    generatedAt: now.toISOString(),
  };
}
