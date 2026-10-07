import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { getServerEnv } from "@/lib/env";
import { logInfo } from "@/lib/logger";
import { getPrisma } from "@/lib/prisma";
import { createOpaqueToken, hashOpaqueToken } from "@/modules/access/tokens";
import { AccountEmailNotConfiguredError, getAccountEmailSender } from "@/modules/communications/account-email";

/**
 * New club application email (#817). Three messages, all queued in the account
 * slice of the outbox (no event, sender from `ACCOUNT_EMAIL_*`) in the same
 * transaction as the change they announce, then delivered best-effort once it
 * commits (`deliver.ts`, kept apart so the delivery worker can import this file
 * without a cycle):
 *
 * - To the configured notification address when an application arrives. It
 *   carries the club name, the church and the director's name, plus a link,
 *   and nothing else: no phone, address, email, note or attachment.
 * - To the applicant when a system administrator declines, with the reason
 *   when one was given. (An approval is the ordinary club director invite.)
 * - To a prospective director with their private "apply" link. Like a club
 *   form link, the body holds a sentinel and never a token: the token is
 *   minted at delivery and only its SHA-256 is stored.
 *
 * Free text goes into a body that delivery scans for `{{...}}` sentinels, so
 * it is neutralized first, and delivery skips sentinel handling for these
 * templates except the invite link's own.
 */

type Outbox = Pick<Prisma.TransactionClient, "messageOutbox">;

export const NEW_CLUB_APPLICATION_LINK_SENTINEL = "{{new_club_application_link}}";
export const NEW_CLUB_APPLICATION_INVITE_TEMPLATE_KEY = "NEW_CLUB_APPLICATION_INVITE";

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

export function newClubApplicationInvitePath(token: string) {
  return `/clubs/register/${encodeURIComponent(token)}`;
}

export type SubmittedEmailInput = {
  applicationId: string;
  clubName: string;
  churchName: string;
  directorName: string;
};

/** What the notification says. Exported so a test can read exactly what would be sent. */
export function submittedEmailContent(rawInput: SubmittedEmailInput) {
  const input = {
    clubName: neutralizePlaceholders(rawInput.clubName),
    churchName: neutralizePlaceholders(rawInput.churchName),
    directorName: neutralizePlaceholders(rawInput.directorName),
  };
  return {
    subject: `New club application: ${input.clubName}`,
    bodyText: [
      "A new club application was submitted.",
      "",
      `Club: ${input.clubName}`,
      `Church: ${input.churchName}`,
      `Director: ${input.directorName}`,
      "",
      "Review it (sign-in required):",
      link("/admin/clubs/applications"),
      "",
      "IMSDA Events",
    ].join("\n"),
  };
}

export async function queueSubmittedEmail(client: Outbox, notifyEmail: string | null, input: SubmittedEmailInput): Promise<string[]> {
  if (!notifyEmail) {
    logInfo("A new club application arrived but no notification address is set in system settings.", { applicationId: input.applicationId });
    return [];
  }
  const from = await sender();
  if (!from) return [];
  const content = submittedEmailContent(input);
  const message = await client.messageOutbox.create({
    data: {
      eventId: null,
      templateKey: "NEW_CLUB_APPLICATION_SUBMITTED",
      recipientKind: "INTERNAL",
      recipientEmail: notifyEmail,
      recipientName: null,
      senderNameSnapshot: from.name,
      senderEmailSnapshot: from.address,
      replyToEmailSnapshot: from.replyTo,
      subjectSnapshot: content.subject,
      bodyTextSnapshot: content.bodyText,
      metadata: { trigger: "NEW_CLUB_APPLICATION_SUBMITTED", applicationId: input.applicationId, accountEmail: false, realDelivery: true },
      idempotencyKey: `new-club-application:${input.applicationId}:submitted`,
      correlationId: randomUUID(),
      status: "PENDING",
    },
    select: { id: true },
  });
  return [message.id];
}

export type DeclinedEmailInput = {
  applicationId: string;
  email: string;
  directorName: string;
  clubName: string;
  reason: string | null;
};

export async function queueDeclinedEmail(client: Outbox, input: DeclinedEmailInput): Promise<string[]> {
  const from = await sender();
  if (!from) return [];
  const name = neutralizePlaceholders(input.directorName.trim()) || "there";
  const clubName = neutralizePlaceholders(input.clubName);
  const reason = input.reason ? neutralizePlaceholders(input.reason) : null;
  const message = await client.messageOutbox.create({
    data: {
      eventId: null,
      templateKey: "NEW_CLUB_APPLICATION_DECLINED",
      recipientKind: "ACCOUNT",
      recipientEmail: input.email,
      recipientName: input.directorName.trim() || null,
      senderNameSnapshot: from.name,
      senderEmailSnapshot: from.address,
      replyToEmailSnapshot: from.replyTo,
      subjectSnapshot: `Your application for ${clubName}`,
      bodyTextSnapshot: [
        `Hello ${name},`,
        "",
        `Thank you for applying to start ${clubName}. The conference was not able to approve the application at this time.`,
        ...(reason ? ["", "Reason:", reason] : []),
        "",
        "If you have questions, or things change, please contact the conference youth department.",
        "",
        "IMSDA Events",
      ].join("\n"),
      metadata: { trigger: "NEW_CLUB_APPLICATION_DECLINED", applicationId: input.applicationId, accountEmail: true, realDelivery: true },
      idempotencyKey: `new-club-application:${input.applicationId}:declined`,
      correlationId: randomUUID(),
      status: "PENDING",
    },
    select: { id: true },
  });
  return [message.id];
}

export async function queueInviteLinkEmail(
  client: Outbox,
  input: { inviteId: string; email: string; name: string; days: number },
): Promise<string | null> {
  const from = await sender();
  if (!from) return null;
  const name = neutralizePlaceholders(input.name.trim()) || "there";
  const message = await client.messageOutbox.create({
    data: {
      eventId: null,
      templateKey: NEW_CLUB_APPLICATION_INVITE_TEMPLATE_KEY,
      recipientKind: "ACCOUNT",
      recipientEmail: input.email,
      recipientName: input.name.trim() || null,
      senderNameSnapshot: from.name,
      senderEmailSnapshot: from.address,
      replyToEmailSnapshot: from.replyTo,
      subjectSnapshot: "Apply to start a new club on IMSDA Events",
      bodyTextSnapshot: [
        `Hello ${name},`,
        "",
        "The Iowa-Missouri Conference has invited you to apply to start a new Pathfinder or Adventurer club. Open your private link to fill in the application:",
        "",
        NEW_CLUB_APPLICATION_LINK_SENTINEL,
        "",
        `The link works once and expires in ${input.days} days. After you submit the application, it stops working.`,
        "",
        "Please don't forward this email: anyone who has the link can submit the application. If you weren't expecting it, you can ignore it. Nothing happens unless you fill the application in.",
        "",
        "IMSDA Events",
      ].join("\n"),
      metadata: { trigger: "NEW_CLUB_APPLICATION_INVITE", inviteId: input.inviteId, accountEmail: false, realDelivery: true },
      idempotencyKey: `new-club-application-invite:${input.inviteId}:${randomUUID()}`,
      correlationId: randomUUID(),
      status: "PENDING",
    },
    select: { id: true },
  });
  return message.id;
}

/**
 * Delivery-time preparation for the invite message: mints the token, stores
 * only its hash (replacing any earlier attempt's), and swaps the sentinel for
 * the link. Refuses when the invite was cancelled, used or has expired.
 */
export async function prepareNewClubInviteBodyForDelivery(input: { messageId: string; bodyText: string; now: Date }) {
  if (!input.bodyText.includes(NEW_CLUB_APPLICATION_LINK_SENTINEL)) return { bodyText: input.bodyText };
  const prisma = getPrisma();
  const invite = await prisma.newClubApplicationInvite.findUnique({
    where: { messageId: input.messageId },
    select: { id: true, usedAt: true, cancelledAt: true, expiresAt: true },
  });
  if (!invite || invite.usedAt || invite.cancelledAt || invite.expiresAt <= input.now) {
    throw new Error("A new club application link can't be delivered: it was withdrawn, used or has expired.");
  }
  const token = createOpaqueToken();
  const guarded = await prisma.newClubApplicationInvite.updateMany({
    where: { id: invite.id, usedAt: null, cancelledAt: null, expiresAt: { gt: input.now } },
    data: { tokenHash: hashOpaqueToken(token) },
  });
  if (guarded.count === 0) throw new Error("A new club application link can't be delivered: it was withdrawn, used or has expired.");
  const url = new URL(newClubApplicationInvitePath(token), getServerEnv().APP_BASE_URL).toString();
  return {
    bodyText: input.bodyText.replaceAll(NEW_CLUB_APPLICATION_LINK_SENTINEL, url),
    revokeOnDefinitiveFailure: async () => {
      await prisma.newClubApplicationInvite.updateMany({
        where: { id: invite.id, usedAt: null },
        data: { cancelledAt: input.now, tokenHash: null },
      });
    },
  };
}

/** Withdraws the link a message carried when its email finally fails. Safe for any message. */
export async function retireNewClubInviteForMessage(
  client: Pick<Prisma.TransactionClient, "newClubApplicationInvite">,
  messageId: string,
  now: Date,
) {
  const retired = await client.newClubApplicationInvite.updateMany({
    where: { messageId, usedAt: null, cancelledAt: null },
    data: { cancelledAt: now, tokenHash: null },
  });
  return retired.count;
}
