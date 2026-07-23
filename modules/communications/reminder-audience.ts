import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  BalanceReminderPreview,
  BalanceReminderRecipient,
  BalanceReminderSkipReasonCode,
  MessagingSettingsRecord,
} from "@/modules/communications/types";

export type BalanceReminderCandidate = {
  registrationId: string;
  confirmationCode: string;
  status: string;
  recipientName: string;
  recipientEmail: string;
  totalCents: number;
  netPaidCents: number;
};

export type BalanceReminderPreviewContext = {
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

const skipReasonLabels: Record<BalanceReminderSkipReasonCode, string> = {
  INACTIVE_REGISTRATION: "Not submitted or confirmed",
  NO_BALANCE_DUE: "No balance is due",
  INVALID_CONTACT_EMAIL: "Missing or invalid contact email",
};

function normalizedEmail(value: string) {
  return value.trim().toLowerCase();
}

function fingerprintPayload(
  context: BalanceReminderPreviewContext,
  recipients: BalanceReminderRecipient[],
  skipCounts: Record<BalanceReminderSkipReasonCode, number>,
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
      totalCents: recipient.totalCents,
      balanceCents: recipient.balanceCents,
    })),
    skipCounts,
  };
}

export function computeBalanceReminderPreview(
  candidates: BalanceReminderCandidate[],
  context: BalanceReminderPreviewContext,
  now = new Date(),
): BalanceReminderPreview {
  const recipients: BalanceReminderRecipient[] = [];
  const skipCounts: Record<BalanceReminderSkipReasonCode, number> = {
    INACTIVE_REGISTRATION: 0,
    NO_BALANCE_DUE: 0,
    INVALID_CONTACT_EMAIL: 0,
  };

  for (const candidate of [...candidates].sort((left, right) => (
    left.registrationId.localeCompare(right.registrationId)
  ))) {
    if (candidate.status !== "SUBMITTED" && candidate.status !== "CONFIRMED") {
      skipCounts.INACTIVE_REGISTRATION += 1;
      continue;
    }

    const balanceCents = Math.max(candidate.totalCents - candidate.netPaidCents, 0);
    if (balanceCents <= 0) {
      skipCounts.NO_BALANCE_DUE += 1;
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
      totalCents: candidate.totalCents,
      balanceCents,
    });
  }

  const serialized = JSON.stringify(fingerprintPayload(context, recipients, skipCounts));
  const skippedCount = Object.values(skipCounts).reduce((sum, count) => sum + count, 0);
  return {
    fingerprint: createHash("sha256").update(serialized).digest("hex"),
    generatedAt: now.toISOString(),
    includedCount: recipients.length,
    skippedCount,
    totalBalanceCents: recipients.reduce(
      (sum, recipient) => sum + recipient.balanceCents,
      0,
    ),
    deliveryMode: context.deliveryMode,
    templateEnabled: context.templateEnabled,
    templateVersionNumber: context.templateVersionNumber,
    recipients,
    skipReasons: (Object.keys(skipCounts) as BalanceReminderSkipReasonCode[]).map(
      (code) => ({
        code,
        label: skipReasonLabels[code],
        count: skipCounts[code],
      }),
    ),
  };
}
