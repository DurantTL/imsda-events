import { createHash } from "node:crypto";
import { attachmentSetIssue } from "@/modules/communications/message-file-rules";
import {
  announcementOptOutFor,
  type AnnouncementOptOutRow,
  type AnnouncementOptOutScope,
} from "@/modules/communications/email-preferences";
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
  /** Uploaded pictures the message embeds (the announcement body's and the template's), and why they cannot be sent, if so. */
  pictureIds?: readonly string[];
  pictureProblem?: string | null;
  /** An event manager marked this announcement essential (#838): it reaches people who opted out. */
  essential?: boolean;
};

/** The opt-outs that apply to the candidates for this event (#838), loaded once for the review and the send alike. */
export type AnnouncementBroadcastOptOutOptions = {
  eventId: string;
  optOuts: readonly AnnouncementOptOutRow[];
  essential: boolean;
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

export type AnnouncementBroadcastOptedOut = {
  registrationId: string;
  scope: AnnouncementOptOutScope;
};

/**
 * The single recipient rule for an announcement broadcast. The preview counts
 * and fingerprints this list, and the send enqueues exactly this list with
 * each resolved email, so what staff reviewed is what goes out.
 */
export function resolveAnnouncementBroadcastAudience(
  candidates: readonly AnnouncementBroadcastCandidate[],
  optOutOptions?: AnnouncementBroadcastOptOutOptions,
) {
  const recipients: AnnouncementBroadcastRecipient[] = [];
  const skippedRegistrationIds: string[] = [];
  // Opted out of announcements (#838): skipped, unless the announcement is essential, in which case they are still
  // sent it and counted separately so staff see how many opted-out people it reaches.
  const optedOut: AnnouncementBroadcastOptedOut[] = [];
  const essentialOverride: AnnouncementBroadcastOptedOut[] = [];
  const ordered = [...candidates].sort((a, b) => a.registrationId.localeCompare(b.registrationId));
  for (const candidate of ordered) {
    const recipientEmail = announcementRecipientEmail(
      candidate.contactSnapshot,
      candidate.accountHolderNormalizedEmail,
    );
    if (recipientEmail) {
      const scope = optOutOptions
        ? announcementOptOutFor(optOutOptions.optOuts, recipientEmail, optOutOptions.eventId)
        : null;
      if (scope && !optOutOptions?.essential) {
        optedOut.push({ registrationId: candidate.registrationId, scope });
        continue;
      }
      if (scope) essentialOverride.push({ registrationId: candidate.registrationId, scope });
      recipients.push({ registrationId: candidate.registrationId, recipientEmail });
    } else {
      skippedRegistrationIds.push(candidate.registrationId);
    }
  }
  return { recipients, skippedRegistrationIds, optedOut, essentialOverride };
}

export function computeAnnouncementBroadcastPreview(
  candidates: readonly AnnouncementBroadcastCandidate[],
  context: AnnouncementBroadcastPreviewContext,
  now = new Date(),
  optOuts: readonly AnnouncementOptOutRow[] = [],
): AnnouncementBroadcastPreview {
  const essential = context.essential === true;
  const { recipients, skippedRegistrationIds, optedOut, essentialOverride } = resolveAnnouncementBroadcastAudience(
    candidates,
    { eventId: context.eventId, optOuts, essential },
  );
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
    pictures: [...(context.pictureIds ?? [])],
    recipients,
    skippedRegistrationIds,
    // Opt-outs and the essential flag change who receives it, so the send refuses a review they moved under (#838).
    optedOut,
    essential,
  })).digest("hex");

  return {
    announcementId: context.announcement.id,
    title: context.announcement.title,
    audienceLabel: ANNOUNCEMENT_BROADCAST_AUDIENCE_LABEL,
    activeRegistrationCount: candidates.length,
    recipientCount: recipients.length,
    skippedNoEmailCount: skippedRegistrationIds.length,
    skippedOptedOutCount: optedOut.length,
    skippedOptedOutEventCount: optedOut.filter((entry) => entry.scope === "EVENT").length,
    skippedOptedOutAllCount: optedOut.filter((entry) => entry.scope === "ALL").length,
    essential,
    essentialOptedOutReachedCount: essentialOverride.length,
    deliveryMode: context.deliveryMode,
    templateEnabled: context.templateEnabled,
    suppressed: context.deliveryMode === "DISABLED" || !context.templateEnabled,
    attachments: attachments.map((file) => ({ filename: file.filename, sizeBytes: file.sizeBytes })),
    attachmentProblem: attachmentSetIssue(attachments)?.message ?? context.pictureProblem ?? null,
    // The one answer to "does this send carry files?", for the dialog and the delivery rule alike: attachments or pictures.
    carriesFiles: attachments.length > 0 || (context.pictureIds ?? []).length > 0,
    fingerprint,
    sendTiming: "IMMEDIATE",
    generatedAt: now.toISOString(),
  };
}
