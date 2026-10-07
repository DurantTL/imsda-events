/**
 * Builds the reviewed audience for a club assignment email batch (#410).
 *
 * Staff send to one club, or to every club whose assignment is fully "set"
 * (campsite, duty, and activity all recorded). A club that is unassigned or
 * only partially assigned is left out of the "every fully assigned club"
 * batch — that message tells a director what they're doing, so sending it
 * before anything is decided would tell them nothing true.
 *
 * "Every fully assigned club" also skips a club whose current assignment
 * version was already emailed (ALREADY_SENT): re-sends happen only after a
 * change bumps the version. Staff can still resend one club explicitly with
 * the ONE scope, where the preview flags it as already sent.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  clubAssignmentEmailBlock,
  clubAssignmentStatus,
  type ClubAssignmentFields,
} from "@/modules/club-registrations/assignments";
import type { MessagingSettingsRecord } from "@/modules/communications/types";

/**
 * The identity of one registration in an assignment batch (#809): the club's id, as it always was, for a registration
 * without a team, and the club's id with the team's key for each team, so a club's teams are told apart.
 */
export function assignmentRecipientKey(entry: { organizationId: string; teamKey?: string | null }) {
  return entry.teamKey ? `${entry.organizationId}:${entry.teamKey}` : entry.organizationId;
}

export type ClubAssignmentCandidate = {
  organizationId: string;
  /** The club's name, or "Team (Club)" for a team (#809). */
  organizationName: string;
  teamKey?: string;
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
  | { scope: "ONE"; organizationId: string; teamKey?: string }
  | { scope: "ALL_SET" };

export type ClubAssignmentSkipReasonCode =
  | "NOT_FOUND"
  | "INACTIVE_REGISTRATION"
  | "NOT_FULLY_ASSIGNED"
  | "INVALID_CONTACT_EMAIL"
  | "ALREADY_SENT";

const skipReasonLabels: Record<ClubAssignmentSkipReasonCode, string> = {
  NOT_FOUND: "Not a club on this event",
  INACTIVE_REGISTRATION: "Not submitted or confirmed",
  NOT_FULLY_ASSIGNED: "Campsite, duty, and activity aren't all set yet",
  INVALID_CONTACT_EMAIL: "Missing or invalid contact email",
  ALREADY_SENT: "Already emailed this version; edit the assignment or send to this club alone to resend",
};

export type ClubAssignmentRecipient = {
  organizationId: string;
  organizationName: string;
  teamKey?: string;
  clubEventRegistrationId: string;
  registrationId: string;
  confirmationCode: string;
  recipientName: string;
  recipientEmail: string;
  assignmentBlock: string;
  version: number;
  lastEmailedVersion: number | null;
  alreadySentThisVersion: boolean;
};

export type ClubAssignmentSkip = {
  organizationId: string;
  organizationName: string;
  teamKey?: string;
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
  /**
   * The first recipient's message rendered through the event's published
   * template, so staff read the real wording before sending. Filled in by the
   * repository (it needs the template); null when no club is included.
   */
  sample: { organizationId: string; teamKey?: string; subject: string; body: string } | null;
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
      ...(candidate.teamKey ? { teamKey: candidate.teamKey } : {}),
      code,
      label: skipReasonLabels[code],
    });
  };

  const targets = selection.scope === "ONE"
    ? candidates.filter((candidate) => candidate.organizationId === selection.organizationId && (candidate.teamKey ?? "") === (selection.teamKey ?? ""))
    : candidates;

  if (selection.scope === "ONE" && targets.length === 0) {
    skipped.push({
      organizationId: selection.organizationId,
      organizationName: "",
      ...(selection.teamKey ? { teamKey: selection.teamKey } : {}),
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
    const alreadySentThisVersion = candidate.lastEmailedVersion === candidate.version;
    if (alreadySentThisVersion && selection.scope === "ALL_SET") {
      skip(candidate, "ALREADY_SENT");
      continue;
    }
    recipients.push({
      organizationId: candidate.organizationId,
      organizationName: candidate.organizationName,
      ...(candidate.teamKey ? { teamKey: candidate.teamKey } : {}),
      clubEventRegistrationId: candidate.clubEventRegistrationId,
      registrationId: candidate.registrationId,
      confirmationCode: candidate.confirmationCode,
      recipientName: candidate.recipientName.trim() || "Club director",
      recipientEmail,
      assignmentBlock: clubAssignmentEmailBlock(candidate.fields),
      version: candidate.version,
      lastEmailedVersion: candidate.lastEmailedVersion,
      alreadySentThisVersion,
    });
  }

  const fingerprint = createHash("sha256").update(JSON.stringify({
    version: 2,
    eventId: context.eventId,
    scope: selection.scope,
    selectedOrganizationId: selection.scope === "ONE" ? selection.organizationId : null,
    ...(selection.scope === "ONE" && selection.teamKey ? { selectedTeamKey: selection.teamKey } : {}),
    deliveryMode: context.deliveryMode,
    senderName: context.senderName,
    senderEmail: context.senderEmail,
    replyToEmail: context.replyToEmail,
    templateEnabled: context.templateEnabled,
    templateVersionId: context.templateVersionId,
    templateVersionNumber: context.templateVersionNumber,
    recipients: recipients.map((recipient) => ({
      organizationId: recipient.organizationId,
      ...(recipient.teamKey ? { teamKey: recipient.teamKey } : {}),
      confirmationCode: recipient.confirmationCode,
      recipientEmail: recipient.recipientEmail,
      assignmentBlock: recipient.assignmentBlock,
      version: recipient.version,
      // A send stamps this, so a batch reviewed before another send finished
      // no longer matches and can't email the same version twice.
      lastEmailedVersion: recipient.lastEmailedVersion,
    })),
    skipped: skipped.map((entry) => ({ organizationId: entry.organizationId, ...(entry.teamKey ? { teamKey: entry.teamKey } : {}), code: entry.code })),
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
    sample: null,
  };
}
