import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { getServerEnv } from "@/lib/env";
import { logError, logInfo } from "@/lib/logger";
import {
  AccountEmailNotConfiguredError,
  getAccountEmailSender,
  isAccountEmailConfigured,
} from "@/modules/communications/account-email";
import { processAccountEmailQueue } from "@/modules/communications/email-delivery";
import { getPlatformSettings } from "@/modules/system-admin/platform-settings";

/**
 * Module request email (#741 slice 3). Two messages, both queued in the
 * account slice of the outbox (no event, sender from `ACCOUNT_EMAIL_*`) in the
 * same transaction as the change they announce, then delivered best-effort
 * after it commits:
 *
 * - To the conference office when a request is made. The office address is
 *   the platform settings "Support contact". Blank means no email is queued;
 *   the request still waits in the System management queue.
 * - To the requester when a system administrator decides. The decline
 *   reason goes to the requester in the body only, never into audit metadata.
 *
 * Delivery follows the deployment's account email setup: with no Resend key the
 * rows stay queued and nothing leaves the building (the local state), which is
 * also what tests read.
 */

type Outbox = Pick<Prisma.TransactionClient, "messageOutbox">;

/**
 * Free text (a reason, an event name) goes into a body that delivery scans for
 * `{{...}}` sentinels. Breaking up the braces means nothing a person types can
 * ever look like one. Delivery also skips sentinel handling for these templates.
 */
export function neutralizePlaceholders(value: string): string {
  return value.replaceAll("{{", "{ {").replaceAll("}}", "} }");
}

function link(path: string) {
  try {
    return new URL(path, getServerEnv().APP_BASE_URL).toString();
  } catch {
    return path;
  }
}

async function sender() {
  try {
    return getAccountEmailSender();
  } catch (error) {
    if (error instanceof AccountEmailNotConfiguredError) return null;
    throw error;
  }
}

export type SubmittedEmailInput = {
  requestId: string;
  moduleTitle: string;
  eventName: string;
  requesterName: string;
  reason: string;
};

/** The office address, read before the transaction opens. Null when none is set. */
export async function conferenceOfficeAddress(): Promise<string | null> {
  const settings = await getPlatformSettings();
  return settings.supportContact?.trim() || null;
}

export async function queueRequestSubmittedEmail(client: Outbox, officeEmail: string | null, rawInput: SubmittedEmailInput): Promise<string[]> {
  const input = {
    ...rawInput,
    moduleTitle: neutralizePlaceholders(rawInput.moduleTitle),
    eventName: neutralizePlaceholders(rawInput.eventName),
    requesterName: neutralizePlaceholders(rawInput.requesterName),
    reason: neutralizePlaceholders(rawInput.reason),
  };
  if (!officeEmail) {
    logInfo("A module request was made but no conference office address is set in platform settings.", { requestId: input.requestId });
    return [];
  }
  const from = await sender();
  if (!from) return [];
  const message = await client.messageOutbox.create({
    data: {
      eventId: null,
      templateKey: "MODULE_REQUEST_SUBMITTED",
      recipientKind: "INTERNAL",
      recipientEmail: officeEmail,
      recipientName: null,
      senderNameSnapshot: from.name,
      senderEmailSnapshot: from.address,
      replyToEmailSnapshot: from.replyTo,
      subjectSnapshot: `Feature request: ${input.moduleTitle} for ${input.eventName}`,
      bodyTextSnapshot: [
        "An event admin asked for a feature to be turned on.",
        "",
        `Event: ${input.eventName}`,
        `Feature: ${input.moduleTitle}`,
        `Requested by: ${input.requesterName}`,
        "",
        "Why:",
        input.reason,
        "",
        "Review it in System management:",
        link("/admin#module-requests"),
        "",
        "IMSDA Events",
      ].join("\n"),
      metadata: { trigger: "MODULE_REQUEST_SUBMITTED", requestId: input.requestId, accountEmail: false, realDelivery: true },
      idempotencyKey: `module-request:${input.requestId}:submitted`,
      correlationId: randomUUID(),
      status: "PENDING",
    },
    select: { id: true },
  });
  return [message.id];
}

export type DecidedEmailInput = {
  requestId: string;
  decision: "APPROVED" | "DECLINED";
  moduleTitle: string;
  eventId: string;
  eventName: string;
  requester: { id: string; email: string; displayName: string };
  declineReason?: string;
};

export async function queueRequestDecidedEmail(client: Outbox, rawInput: DecidedEmailInput): Promise<string[]> {
  const input = {
    ...rawInput,
    moduleTitle: neutralizePlaceholders(rawInput.moduleTitle),
    eventName: neutralizePlaceholders(rawInput.eventName),
    declineReason: rawInput.declineReason === undefined ? undefined : neutralizePlaceholders(rawInput.declineReason),
  };
  const from = await sender();
  if (!from) return [];
  const approved = input.decision === "APPROVED";
  const name = neutralizePlaceholders(input.requester.displayName.trim()) || "there";
  const message = await client.messageOutbox.create({
    data: {
      eventId: null,
      accountUserId: input.requester.id,
      templateKey: "MODULE_REQUEST_DECIDED",
      recipientKind: "ACCOUNT",
      recipientEmail: input.requester.email,
      recipientName: rawInput.requester.displayName.trim() || null,
      senderNameSnapshot: from.name,
      senderEmailSnapshot: from.address,
      replyToEmailSnapshot: from.replyTo,
      subjectSnapshot: approved
        ? `${input.moduleTitle} is now on for ${input.eventName}`
        : `Your request for ${input.moduleTitle} was declined`,
      bodyTextSnapshot: [
        `Hello ${name},`,
        "",
        approved
          ? `Your request for ${input.moduleTitle} on ${input.eventName} was approved. It is on now.`
          : `Your request for ${input.moduleTitle} on ${input.eventName} was declined.`,
        ...(approved ? [] : ["", "Reason:", input.declineReason ?? "", "", "You can ask again from the event's More page if things change."]),
        "",
        link(`/more?event=${encodeURIComponent(input.eventId)}`),
        "",
        "IMSDA Events",
      ].join("\n"),
      metadata: { trigger: "MODULE_REQUEST_DECIDED", requestId: input.requestId, decision: input.decision, accountEmail: true, realDelivery: true },
      idempotencyKey: `module-request:${input.requestId}:decided`,
      correlationId: randomUUID(),
      status: "PENDING",
    },
    select: { id: true },
  });
  return [message.id];
}

/** Best-effort delivery after the transaction commits. Never throws; the sweep retries what fails. */
export async function deliverRequestEmails(messageIds: readonly string[]): Promise<void> {
  if (messageIds.length === 0 || !isAccountEmailConfigured()) return;
  try {
    await processAccountEmailQueue({ messageIds: [...messageIds] });
  } catch (error) {
    logError("A module request email could not be delivered now.", error, { count: messageIds.length });
  }
}
