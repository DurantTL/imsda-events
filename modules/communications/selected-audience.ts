import { createHash } from "node:crypto";
import { z } from "zod";
import type { MessagingSettingsRecord } from "@/modules/communications/types";

/**
 * Sending one template to a staff-chosen set of registrations.
 *
 * The event-wide batches already cover "everyone who owes money" and
 * "everyone missing a shirt size". What they never covered is the ordinary
 * case: eleven people on a list, a reminder they specifically need, and no way
 * to send it without opening eleven records or emailing outside the system,
 * where nothing is recorded against the registration.
 *
 * The chosen set is an input, not the audience. Every eligibility rule the
 * event-wide batch applies still applies here, so a selection that includes a
 * cancelled registration or a settled balance sends nothing to it and says so.
 */

/**
 * Templates staff may send to a chosen set. Deliberately short: each one
 * describes the registration as it already stands. A template that announces
 * a state change — a promotion, a cancellation, a transfer — is sent by the
 * operation that makes the change, never by hand at a selection, because an
 * email saying a place opened up is not true until one has.
 */
export const selectedAudienceTemplateKeys = [
  "BALANCE_REMINDER",
  "EVENT_ANNOUNCEMENT",
] as const;

export type SelectedAudienceTemplateKey =
  typeof selectedAudienceTemplateKeys[number];

export const selectedAudienceTemplateLabels:
  Readonly<Record<SelectedAudienceTemplateKey, string>> = {
    BALANCE_REMINDER: "Balance reminder",
    EVENT_ANNOUNCEMENT: "Event announcement",
  };

export const selectedAudienceBatchInputSchema = z.strictObject({
  batchId: z.uuid(),
  templateKey: z.enum(selectedAudienceTemplateKeys),
  // A cap, not a guess: a staff-chosen set that runs to hundreds is the
  // event-wide batch wearing a disguise, and that batch has its own preview.
  registrationIds: z.array(z.string().trim().min(1).max(64)).min(1).max(250),
  announcementTitle: z.string().trim().max(120).default(""),
  announcementBody: z.string().trim().max(4_000).default(""),
  previewFingerprint: z.string().trim().length(64),
}).superRefine((value, context) => {
  if (value.templateKey !== "EVENT_ANNOUNCEMENT") return;
  if (!value.announcementTitle) {
    context.addIssue({
      code: "custom",
      path: ["announcementTitle"],
      message: "An announcement needs a title.",
    });
  }
  if (!value.announcementBody) {
    context.addIssue({
      code: "custom",
      path: ["announcementBody"],
      message: "An announcement needs a message.",
    });
  }
});

export type SelectedAudienceBatchInput = z.infer<
  typeof selectedAudienceBatchInputSchema
>;

export type SelectedAudienceSkipReasonCode =
  | "NOT_FOUND"
  | "INACTIVE_REGISTRATION"
  | "NO_BALANCE_DUE"
  | "INVALID_CONTACT_EMAIL"
  | "ORGANIZATION_BILLED";

const skipReasonLabels: Record<SelectedAudienceSkipReasonCode, string> = {
  NOT_FOUND: "Not a registration on this event",
  INACTIVE_REGISTRATION: "Not submitted or confirmed",
  NO_BALANCE_DUE: "No balance is due",
  INVALID_CONTACT_EMAIL: "Missing or invalid contact email",
  ORGANIZATION_BILLED: "Event bills the responsible organization, not the attendee",
};

export type SelectedAudienceCandidate = {
  registrationId: string;
  confirmationCode: string;
  status: string;
  recipientName: string;
  recipientEmail: string;
  totalCents: number;
  netPaidCents: number;
};

export type SelectedAudienceRecipient = {
  registrationId: string;
  confirmationCode: string;
  recipientName: string;
  recipientEmail: string;
  totalCents: number;
  balanceCents: number;
};

export type SelectedAudienceSkip = {
  registrationId: string;
  confirmationCode: string;
  recipientName: string;
  code: SelectedAudienceSkipReasonCode;
  label: string;
};

export type SelectedAudiencePreview = {
  fingerprint: string;
  generatedAt: string;
  templateKey: SelectedAudienceTemplateKey;
  selectedCount: number;
  includedCount: number;
  skippedCount: number;
  totalBalanceCents: number;
  deliveryMode: MessagingSettingsRecord["deliveryMode"];
  templateEnabled: boolean;
  templateVersionNumber: number | null;
  recipients: SelectedAudienceRecipient[];
  skipped: SelectedAudienceSkip[];
};

export type SelectedAudiencePreviewContext = {
  eventId: string;
  templateKey: SelectedAudienceTemplateKey;
  isDeferredOrganizationBilling?: boolean;
  deliveryMode: MessagingSettingsRecord["deliveryMode"];
  senderName: string;
  senderEmail: string | null;
  replyToEmail: string | null;
  templateEnabled: boolean;
  templateVersionId: string | null;
  templateVersionNumber: number | null;
};

const emailSchema = z.email();

function normalizedEmail(value: string) {
  return value.trim().toLowerCase();
}

/**
 * Skips are listed one by one rather than counted.
 *
 * The event-wide batch only ever needs the count — nobody chose those
 * registrations. Here somebody did, so "three of your eleven got nothing"
 * without saying which three is the version of this feature that quietly
 * loses people.
 */
export function computeSelectedAudiencePreview(
  registrationIds: readonly string[],
  candidates: readonly SelectedAudienceCandidate[],
  context: SelectedAudiencePreviewContext,
  now = new Date(),
): SelectedAudiencePreview {
  const byId = new Map(
    candidates.map((candidate) => [candidate.registrationId, candidate] as const),
  );
  const selected = [...new Set(registrationIds)].sort();
  const recipients: SelectedAudienceRecipient[] = [];
  const skipped: SelectedAudienceSkip[] = [];

  const skip = (
    registrationId: string,
    candidate: SelectedAudienceCandidate | undefined,
    code: SelectedAudienceSkipReasonCode,
  ) => {
    skipped.push({
      registrationId,
      confirmationCode: candidate?.confirmationCode ?? "",
      recipientName: candidate?.recipientName.trim() || "Registrant",
      code,
      label: skipReasonLabels[code],
    });
  };

  for (const registrationId of selected) {
    const candidate = byId.get(registrationId);
    if (!candidate) {
      skip(registrationId, undefined, "NOT_FOUND");
      continue;
    }
    if (candidate.status !== "SUBMITTED" && candidate.status !== "CONFIRMED") {
      skip(registrationId, candidate, "INACTIVE_REGISTRATION");
      continue;
    }
    const balanceCents = Math.max(candidate.totalCents - candidate.netPaidCents, 0);
    if (context.templateKey === "BALANCE_REMINDER") {
      if (context.isDeferredOrganizationBilling) {
        skip(registrationId, candidate, "ORGANIZATION_BILLED");
        continue;
      }
      if (balanceCents <= 0) {
        skip(registrationId, candidate, "NO_BALANCE_DUE");
        continue;
      }
    }
    const recipientEmail = normalizedEmail(candidate.recipientEmail);
    if (!emailSchema.safeParse(recipientEmail).success) {
      skip(registrationId, candidate, "INVALID_CONTACT_EMAIL");
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

  const fingerprint = createHash("sha256").update(JSON.stringify({
    version: 1,
    eventId: context.eventId,
    templateKey: context.templateKey,
    deliveryMode: context.deliveryMode,
    senderName: context.senderName,
    senderEmail: context.senderEmail,
    replyToEmail: context.replyToEmail,
    templateEnabled: context.templateEnabled,
    templateVersionId: context.templateVersionId,
    templateVersionNumber: context.templateVersionNumber,
    recipients,
    skipped: skipped.map((entry) => ({
      registrationId: entry.registrationId,
      code: entry.code,
    })),
  })).digest("hex");

  return {
    fingerprint,
    generatedAt: now.toISOString(),
    templateKey: context.templateKey,
    selectedCount: selected.length,
    includedCount: recipients.length,
    skippedCount: skipped.length,
    totalBalanceCents: recipients.reduce(
      (sum, recipient) => sum + recipient.balanceCents,
      0,
    ),
    deliveryMode: context.deliveryMode,
    templateEnabled: context.templateEnabled,
    templateVersionNumber: context.templateVersionNumber,
    recipients,
    skipped,
  };
}
