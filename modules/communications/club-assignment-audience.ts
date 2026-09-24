/**
 * Builds the reviewed audience for a club assignment email batch (#410).
 *
 * Staff send to one club, or to every club whose assignment is fully "set"
 * (campsite, duty, and activity all recorded). A club that is unassigned or
 * only partially assigned is left out of the "every fully assigned club"
 * batch — that message tells a director what they're doing, so sending it
 * before anything is decided would tell them nothing true.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  clubAssignmentEmailBlock,
  clubAssignmentStatus,
  type ClubAssignmentFields,
} from "@/modules/club-registrations/assignments";
import type { MessagingSettingsRecord } from "@/modules/communications/types";

export type ClubAssignmentCandidate = {
  organizationId: string;
  organizationName: string;
  clubEventRegistrationId: string;
  registrationId: string;
  confirmationCode: string;
  registrationStatus: string;
  recipientName: string;
  recipientEmail: string;
  fields: ClubAssignmentFields;
  version: number;
  lastEmailedVersion: number | null;
};

export type ClubAssignmentSendSelection =
  | { scope: "ONE"; organizationId: string }
  | { scope: "ALL_SET" };

export type ClubAssignmentSkipReasonCode =
  | "NOT_FOUND"
  | "INACTIVE_REGISTRATION"
  | "NOT_FULLY_ASSIGNED"
  | "INVALID_CONTACT_EMAIL";

const skipReasonLabels: Record<ClubAssignmentSkipReasonCode, string> = {
  NOT_FOUND: "Not a club on this event",
  INACTIVE_REGISTRATION: "Not submitted or confirmed",
  NOT_FULLY_ASSIGNED: "Campsite, duty, and activity aren't all set yet",
  INVALID_CONTACT_EMAIL: "Missing or invalid contact email",
};

export type ClubAssignmentRecipient = {
  organizationId: string;
  clubEventRegistrationId: string;
  registrationId: string;
  confirmationCode: string;
  recipientName: string;
  recipientEmail: string;
  assignmentBlock: string;
  version: number;
  alreadySentThisVersion: boolean;
};

export type ClubAssignmentSkip = {
  organizationId: string;
  organizationName: string;
  code: ClubAssignmentSkipReasonCode;
  label: string;
};

export type ClubAssignmentPreview = {
  fingerprint: string;
  generatedAt: string;
  scope: ClubAssignmentSendSelection["scope"];
  includedCount: number;
  skippedCount: number;
  deliveryMode: MessagingSettingsRecord["deliveryMode"];
  templateEnabled: boolean;
  templateVersionNumber: number | null;
  recipients: ClubAssignmentRecipient[];
  skipped: ClubAssignmentSkip[];
};

export type ClubAssignmentPreviewContext = {
  eventId: string;
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

export function computeClubAssignmentPreview(
  candidates: readonly ClubAssignmentCandidate[],
  context: ClubAssignmentPreviewContext,
  selection: ClubAssignmentSendSelection,
  now = new Date(),
): ClubAssignmentPreview {
  const recipients: ClubAssignmentRecipient[] = [];
  const skipped: ClubAssignmentSkip[] = [];

  const skip = (candidate: ClubAssignmentCandidate, code: ClubAssignmentSkipReasonCode) => {
    skipped.push({
      organizationId: candidate.organizationId,
      organizationName: candidate.organizationName,
      code,
      label: skipReasonLabels[code],
    });
  };

  const targets = selection.scope === "ONE"
    ? candidates.filter((candidate) => candidate.organizationId === selection.organizationId)
    : candidates;

  if (selection.scope === "ONE" && targets.length === 0) {
    skipped.push({
      organizationId: selection.organizationId,
      organizationName: "",
      code: "NOT_FOUND",
      label: skipReasonLabels.NOT_FOUND,
    });
  }

  for (const candidate of targets) {
    if (candidate.registrationStatus !== "SUBMITTED" && candidate.registrationStatus !== "CONFIRMED") {
      skip(candidate, "INACTIVE_REGISTRATION");
      continue;
    }
    if (clubAssignmentStatus(candidate.fields) !== "SET") {
      skip(candidate, "NOT_FULLY_ASSIGNED");
      continue;
    }
    const recipientEmail = normalizedEmail(candidate.recipientEmail);
    if (!emailSchema.safeParse(recipientEmail).success) {
      skip(candidate, "INVALID_CONTACT_EMAIL");
      continue;
    }
    recipients.push({
      organizationId: candidate.organizationId,
      clubEventRegistrationId: candidate.clubEventRegistrationId,
      registrationId: candidate.registrationId,
      confirmationCode: candidate.confirmationCode,
      recipientName: candidate.recipientName.trim() || "Club director",
      recipientEmail,
      assignmentBlock: clubAssignmentEmailBlock(candidate.fields),
      version: candidate.version,
      alreadySentThisVersion: candidate.lastEmailedVersion === candidate.version,
    });
  }

  const fingerprint = createHash("sha256").update(JSON.stringify({
    version: 1,
    eventId: context.eventId,
    scope: selection.scope,
    selectedOrganizationId: selection.scope === "ONE" ? selection.organizationId : null,
    deliveryMode: context.deliveryMode,
    senderName: context.senderName,
    senderEmail: context.senderEmail,
    replyToEmail: context.replyToEmail,
    recipients: recipients.map((recipient) => ({
      organizationId: recipient.organizationId,
      confirmationCode: recipient.confirmationCode,
      recipientEmail: recipient.recipientEmail,
      assignmentBlock: recipient.assignmentBlock,
      version: recipient.version,
    })),
    skipped: skipped.map((entry) => ({ organizationId: entry.organizationId, code: entry.code })),
  })).digest("hex");

  return {
    fingerprint,
    generatedAt: now.toISOString(),
    scope: selection.scope,
    includedCount: recipients.length,
    skippedCount: skipped.length,
    deliveryMode: context.deliveryMode,
    templateEnabled: context.templateEnabled,
    templateVersionNumber: context.templateVersionNumber,
    recipients,
    skipped,
  };
}
