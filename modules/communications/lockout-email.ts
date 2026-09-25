import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { getServerEnv } from "@/lib/env";
import { logError } from "@/lib/logger";
import { getAccountEmailSender, isAccountEmailConfigured } from "@/modules/communications/account-email";
import { processAccountEmailQueue } from "@/modules/communications/email-delivery";
import { getPlatformSettings } from "@/modules/system-admin/platform-settings";

/**
 * Lockout email (#456): sent once, on the transition from not-locked to
 * locked, for a wrong password or a wrong two-step code — never on every
 * attempt made while the lock stands.
 *
 * Two messages, both queued through the account slice of the outbox (no
 * `eventId`, sender from `ACCOUNT_EMAIL_*`), exactly like activation and
 * password-reset email:
 *
 * - **To the account holder.** Says what kind of attempt locked the account,
 *   when, and how long, with a link to the right reset page. Never the
 *   attempted password or code, and no IP address.
 * - **To the configured security alert address**, if one is set. A short
 *   alert naming the account and the kind of lockout — nothing else.
 *
 * Both calls are best-effort: a failure here must not change, delay, or leak
 * anything into the sign-in response that triggered it. Callers await
 * {@link dispatchLockoutEmails} but never let it throw past them.
 */

export type LockoutAudience = "STAFF" | "ATTENDEE";
export type LockoutKind = "PASSWORD" | "CODE";

const LOCK_MINUTES = 15;

function kindWording(kind: LockoutKind) {
  return kind === "PASSWORD" ? "the wrong password" : "the wrong two-step code";
}

function greeting(displayName: string) {
  return displayName.trim() || "there";
}

/**
 * The conference time zone: `defaultTimezone` on platform settings is the one
 * timezone this deployment states outside of a specific event, so it is what
 * "in the conference time zone" means for an account-level email. Falls back
 * to UTC wording if the configured zone is somehow not a real IANA name.
 */
function formatLockoutTime(now: Date, timeZone: string) {
  try {
    return `${new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(now)} (${timeZone})`;
  } catch {
    return `${now.toISOString()} (UTC)`;
  }
}

function resetPath(audience: LockoutAudience) {
  return audience === "STAFF" ? "/forgot-password" : "/account/forgot-password";
}

function resetUrl(audience: LockoutAudience) {
  return new URL(resetPath(audience), getServerEnv().APP_BASE_URL).toString();
}

function personBody(input: {
  audience: LockoutAudience;
  kind: LockoutKind;
  displayName: string;
  when: string;
}) {
  const subject = "Your IMSDA Events account is temporarily locked";
  const bodyText = [
    `Hello ${greeting(input.displayName)},`,
    "",
    `Someone tried to sign in to this IMSDA Events account with ${kindWording(input.kind)} at ${input.when}.`,
    "",
    `For your security, the account is locked for ${LOCK_MINUTES} minutes.`,
    "",
    "If this wasn't you, reset your password:",
    "",
    resetUrl(input.audience),
    "",
    "If it was you, wait a few minutes and try again.",
    "",
    "IMSDA Events",
  ].join("\n");
  return { subject, bodyText };
}

function officeBody(input: {
  kind: LockoutKind;
  audience: LockoutAudience;
  accountEmail: string;
  when: string;
}) {
  const who = input.audience === "STAFF" ? "staff" : "attendee/club";
  return {
    subject: `Security alert: ${who} account locked`,
    bodyText: [
      `A ${who} account (${input.accountEmail}) was locked at ${input.when} after repeated attempts with ${kindWording(input.kind)}.`,
      "",
      `It unlocks automatically in ${LOCK_MINUTES} minutes.`,
      "",
      "IMSDA Events",
    ].join("\n"),
  };
}

export type LockoutEmailInput = {
  audience: LockoutAudience;
  kind: LockoutKind;
  accountUserId?: string;
  accountAttendeeId?: string;
  /** Identifies this specific lockout instant, so retrying is a no-op. */
  lockedUntil: Date;
  now: Date;
};

type DbClient = Prisma.TransactionClient | ReturnType<typeof getPrisma>;

/**
 * Resolved only here, and only once {@link dispatchLockoutEmails} has already
 * confirmed account email is configured — every caller passes an id, never an
 * address, so nothing about the recipient has to be looked up (or the
 * database touched at all) on a deployment that cannot send this email.
 */
async function lockedOutPerson(client: DbClient, input: LockoutEmailInput) {
  if (input.accountUserId) {
    return client.user.findUnique({
      where: { id: input.accountUserId },
      select: { email: true, displayName: true },
    });
  }
  if (input.accountAttendeeId) {
    return client.attendeeAccount.findUnique({
      where: { id: input.accountAttendeeId },
      select: { email: true, displayName: true },
    });
  }
  return null;
}

async function enqueueLockoutEmails(client: DbClient, input: LockoutEmailInput) {
  const person = await lockedOutPerson(client, input);
  // The account was removed between the failed attempt and this call — rare,
  // and nothing to notify.
  if (!person) return [];

  const sender = getAccountEmailSender();
  const settings = await getPlatformSettings();
  const templateKey = input.audience === "STAFF" ? "ACCOUNT_LOCKOUT" : "ATTENDEE_LOCKOUT";
  const when = formatLockoutTime(input.now, settings.defaultTimezone);
  const lockoutInstant = input.lockedUntil.getTime();
  const correlationId = randomUUID();
  const accountId = input.accountUserId ?? input.accountAttendeeId;

  const personEmail = personBody({
    audience: input.audience,
    kind: input.kind,
    displayName: person.displayName,
    when,
  });
  const messageIds: string[] = [];

  const personMessage = await client.messageOutbox.upsert({
    where: { idempotencyKey: `lockout:${input.kind}:${accountId}:${lockoutInstant}` },
    update: {},
    create: {
      eventId: null,
      accountUserId: input.accountUserId ?? null,
      accountAttendeeId: input.accountAttendeeId ?? null,
      templateKey,
      recipientKind: "ACCOUNT",
      recipientEmail: person.email,
      recipientName: person.displayName.trim() || null,
      senderNameSnapshot: sender.name,
      senderEmailSnapshot: sender.address,
      replyToEmailSnapshot: sender.replyTo,
      subjectSnapshot: personEmail.subject,
      bodyTextSnapshot: personEmail.bodyText,
      metadata: {
        trigger: "SIGN_IN_LOCKOUT",
        lockoutKind: input.kind,
        accountEmail: true,
        realDelivery: true,
      } satisfies Prisma.InputJsonValue,
      idempotencyKey: `lockout:${input.kind}:${accountId}:${lockoutInstant}`,
      correlationId,
      status: "PENDING",
    },
    select: { id: true },
  });
  messageIds.push(personMessage.id);

  if (settings.securityAlertEmail) {
    const office = officeBody({
      kind: input.kind,
      audience: input.audience,
      accountEmail: person.email,
      when,
    });
    const officeMessage = await client.messageOutbox.upsert({
      where: { idempotencyKey: `lockout-alert:${input.kind}:${accountId}:${lockoutInstant}` },
      update: {},
      create: {
        eventId: null,
        // The office alert names an account without belonging to it — it is
        // not the account holder's own inbox, so it carries neither account
        // relation, only the address configured in platform settings.
        templateKey,
        recipientKind: "INTERNAL",
        recipientEmail: settings.securityAlertEmail,
        recipientName: null,
        senderNameSnapshot: sender.name,
        senderEmailSnapshot: sender.address,
        replyToEmailSnapshot: sender.replyTo,
        subjectSnapshot: office.subject,
        bodyTextSnapshot: office.bodyText,
        metadata: {
          trigger: "SIGN_IN_LOCKOUT_ALERT",
          lockoutKind: input.kind,
          accountEmail: false,
          realDelivery: true,
        } satisfies Prisma.InputJsonValue,
        idempotencyKey: `lockout-alert:${input.kind}:${accountId}:${lockoutInstant}`,
        correlationId,
        status: "PENDING",
      },
      select: { id: true },
    });
    messageIds.push(officeMessage.id);
  }

  return messageIds;
}

/**
 * Queues the lockout email(s) and makes a best-effort attempt to deliver them
 * immediately, exactly like an account password-reset email. Never throws:
 * the caller is in the middle of an unauthenticated sign-in path, and a
 * delivery problem here must not change what that path returns, nor leak
 * through a slower or faster response (timing is the whole reason
 * `isAccountEmailConfigured` and the outbox exist). Nothing here touches the
 * database at all on a deployment that cannot send this email.
 */
export async function dispatchLockoutEmails(
  input: LockoutEmailInput,
  client?: Prisma.TransactionClient,
): Promise<void> {
  if (!isAccountEmailConfigured()) return;
  try {
    const messageIds = await enqueueLockoutEmails(client ?? getPrisma(), input);
    // Inside an ambient transaction, sending has to wait until it commits —
    // there is nothing durable to send yet. The scheduled sweep is the
    // durable path for that case; outside one, try now, exactly as account
    // password-reset email does.
    if (!client && messageIds.length > 0) {
      await processAccountEmailQueue({ messageIds });
    }
  } catch (error) {
    logError("A lockout email could not be queued or sent.", error, {
      audience: input.audience,
      kind: input.kind,
    });
  }
}
