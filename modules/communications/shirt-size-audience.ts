/**
 * Builds the reviewed audience for a shirt-size request batch.
 *
 * The legacy Women's Retreat workbook has no shirt-size column at all, so every
 * migrated attendee starts without one and the audience is initially almost the
 * whole event. It shrinks as registrants answer, which is exactly why the
 * audience is recomputed and fingerprinted at preview time rather than stored:
 * staff review what will be sent *now*, and the fingerprint is what makes the
 * batch idempotent against a double-click or a lost response.
 *
 * A registration is included when at least one of its attendees still has no
 * shirt size. Partially answered registrations are included, because the
 * remaining attendee still needs one, and the message names who is missing.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  MessagingSettingsRecord,
  ShirtSizeRecipient,
  ShirtSizeRequestPreview,
  ShirtSizeSkipReasonCode,
} from "@/modules/communications/types";

export type {
  ShirtSizeRecipient,
  ShirtSizeRequestPreview,
  ShirtSizeSkipReasonCode,
};

export type ShirtSizeCandidateAttendee = {
  attendeeId: string;
  fullName: string;
  shirtSize: string | null;
};

export type ShirtSizeCandidate = {
  registrationId: string;
  confirmationCode: string;
  status: string;
  recipientName: string;
  recipientEmail: string;
  attendees: ShirtSizeCandidateAttendee[];
};

export type ShirtSizePreviewContext = {
  eventId: string;
  deliveryMode: MessagingSettingsRecord["deliveryMode"];
  senderName: string;
  senderEmail: string | null;
  replyToEmail: string | null;
  templateEnabled: boolean;
  templateVersionId: string | null;
  templateVersionNumber: number | null;
  eventSnapshot: {
    name: string;
    startsAt: string;
    endsAt: string;
    timezone: string;
    location: string | null;
  };
};

const emailSchema = z.email();

const skipReasonLabels: Record<ShirtSizeSkipReasonCode, string> = {
  INACTIVE_REGISTRATION: "Not submitted or confirmed",
  ALL_SIZES_RECORDED: "Every attendee already has a shirt size",
  NO_ATTENDEES: "No attendees on the registration",
  INVALID_CONTACT_EMAIL: "Missing or invalid contact email",
};

function normalizedEmail(value: string) {
  return value.trim().toLowerCase();
}

function fingerprintPayload(
  context: ShirtSizePreviewContext,
  recipients: ShirtSizeRecipient[],
  skipCounts: Record<ShirtSizeSkipReasonCode, number>,
) {
  return {
    version: 1,
    eventId: context.eventId,
    deliveryMode: context.deliveryMode,
    senderName: context.senderName,
    senderEmail: context.senderEmail,
    replyToEmail: context.replyToEmail,
    templateEnabled: context.templateEnabled,
    templateVersionId: context.templateVersionId,
    templateVersionNumber: context.templateVersionNumber,
    eventSnapshot: context.eventSnapshot,
    recipients: recipients.map((recipient) => ({
      registrationId: recipient.registrationId,
      confirmationCode: recipient.confirmationCode,
      recipientName: recipient.recipientName,
      recipientEmail: recipient.recipientEmail,
      // Named, not just counted: a size answered between two previews has to
      // change the fingerprint, or a stale batch could re-ask the same person.
      missingAttendeeNames: recipient.missingAttendeeNames,
    })),
    skipCounts,
  };
}

export function computeShirtSizeRequestPreview(
  candidates: ShirtSizeCandidate[],
  context: ShirtSizePreviewContext,
  now = new Date(),
): ShirtSizeRequestPreview {
  const recipients: ShirtSizeRecipient[] = [];
  const skipCounts: Record<ShirtSizeSkipReasonCode, number> = {
    INACTIVE_REGISTRATION: 0,
    ALL_SIZES_RECORDED: 0,
    NO_ATTENDEES: 0,
    INVALID_CONTACT_EMAIL: 0,
  };

  for (const candidate of [...candidates].sort((left, right) => (
    left.registrationId.localeCompare(right.registrationId)
  ))) {
    if (candidate.status !== "SUBMITTED" && candidate.status !== "CONFIRMED") {
      skipCounts.INACTIVE_REGISTRATION += 1;
      continue;
    }
    if (candidate.attendees.length === 0) {
      skipCounts.NO_ATTENDEES += 1;
      continue;
    }

    const missing = candidate.attendees.filter((attendee) => !attendee.shirtSize?.trim());
    if (missing.length === 0) {
      skipCounts.ALL_SIZES_RECORDED += 1;
      continue;
    }

    const recipientEmail = normalizedEmail(candidate.recipientEmail);
    if (!emailSchema.safeParse(recipientEmail).success) {
      skipCounts.INVALID_CONTACT_EMAIL += 1;
      continue;
    }

    recipients.push({
      registrationId: candidate.registrationId,
      confirmationCode: candidate.confirmationCode,
      recipientName: candidate.recipientName.trim() || "Registrant",
      recipientEmail,
      missingAttendeeNames: missing.map((attendee) => (
        attendee.fullName.trim() || "Unnamed attendee"
      )),
      missingCount: missing.length,
      attendeeCount: candidate.attendees.length,
    });
  }

  const serialized = JSON.stringify(fingerprintPayload(context, recipients, skipCounts));
  return {
    fingerprint: createHash("sha256").update(serialized).digest("hex"),
    generatedAt: now.toISOString(),
    includedCount: recipients.length,
    skippedCount: Object.values(skipCounts).reduce((sum, count) => sum + count, 0),
    missingAttendeeCount: recipients.reduce(
      (sum, recipient) => sum + recipient.missingCount,
      0,
    ),
    deliveryMode: context.deliveryMode,
    templateEnabled: context.templateEnabled,
    templateVersionNumber: context.templateVersionNumber,
    recipients,
    skipReasons: (Object.keys(skipCounts) as ShirtSizeSkipReasonCode[]).map((code) => ({
      code,
      label: skipReasonLabels[code],
      count: skipCounts[code],
    })),
  };
}

/**
 * The {{attendee_summary}} line for one recipient. Names who is still missing a
 * size rather than listing the whole roster, so a registrant who has answered
 * for two of three people is not asked to redo the two.
 */
export function shirtSizeAttendeeSummary(recipient: ShirtSizeRecipient) {
  return recipient.missingAttendeeNames
    .map((name) => `- ${name}`)
    .join("\n");
}
