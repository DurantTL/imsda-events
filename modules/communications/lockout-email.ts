import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { after } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { getServerEnv } from "@/lib/env";
import { logError } from "@/lib/logger";
import { getAccountEmailSender, isAccountEmailConfigured } from "@/modules/communications/account-email";
import { processAccountEmailQueue } from "@/modules/communications/email-delivery";
import { getPlatformSettings } from "@/modules/system-admin/platform-settings";

/**
 * Lockout email (#456): considered once, on the transition from not-locked to
 * locked, for a wrong password or a wrong two-step code — never on every
 * attempt made while the lock stands. Callers claim that transition with a
 * conditional update, so concurrent wrong attempts cannot each announce it.
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
 * The lock applies every time; the emails are capped per account so that a
 * stream of wrong attempts cannot be turned into a stream of email (#456
 * review): at most one to the person per rolling hour, and at most one office
 * alert per rolling 24 hours.
 *
 * Nothing email-related may run before the sign-in response is sent: an
 * unauthenticated request that took longer only when the address belongs to a
 * real account would be an account-enumeration oracle (the rule in
 * modules/attendee-accounts/attendee-email-dispatch.ts). Callers therefore use
 * {@link scheduleLockoutEmails}, which hands both the enqueue and the delivery
 * to Next.js `after()`; they never await email work themselves.
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
  /** When the lock claimed by the caller ends. */
  lockedUntil: Date;
  now: Date;
};

type DbClient = ReturnType<typeof getPrisma>;

/** At most one lockout email to the account holder per account per hour. */
export const PERSON_EMAIL_WINDOW_MS = 60 * 60 * 1000;
/** At most one office alert per account per 24 hours. */
export const OFFICE_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;

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

/**
 * The cap. Keys are per account (not per kind of lockout), so alternating
 * password and code lockouts share one allowance. The key carries a time
 * bucket of the window's length, which makes two racing dispatches in the
 * same bucket collapse onto one row through the unique `idempotencyKey`; the
 * rolling look-back in {@link sentWithin} closes the gap at a bucket boundary.
 */
function capKeyPrefix(channel: "person" | "office", input: LockoutEmailInput, accountId: string) {
  return `lockout-${channel}:${input.audience}:${accountId}:`;
}

function capKey(prefix: string, now: Date, windowMs: number) {
  return `${prefix}${Math.floor(now.getTime() / windowMs)}`;
}

async function sentWithin(client: DbClient, keyPrefix: string, now: Date, windowMs: number) {
  const recent = await client.messageOutbox.findFirst({
    where: {
      idempotencyKey: { startsWith: keyPrefix },
      createdAt: { gt: new Date(now.getTime() - windowMs) },
    },
    select: { id: true },
  });
  return recent !== null;
}

async function enqueueLockoutEmails(client: DbClient, input: LockoutEmailInput) {
  const accountId = input.accountUserId ?? input.accountAttendeeId;
  if (!accountId) return [];

  const personPrefix = capKeyPrefix("person", input, accountId);
  const officePrefix = capKeyPrefix("office", input, accountId);
  const settings = await getPlatformSettings();
  const personDue = !await sentWithin(client, personPrefix, input.now, PERSON_EMAIL_WINDOW_MS);
  const officeDue = Boolean(settings.securityAlertEmail)
    && !await sentWithin(client, officePrefix, input.now, OFFICE_ALERT_WINDOW_MS);
  if (!personDue && !officeDue) return [];

  const person = await lockedOutPerson(client, input);
  // The account was removed between the failed attempt and this call — rare,
  // and nothing to notify.
  if (!person) return [];

  const sender = getAccountEmailSender();
  const templateKey = input.audience === "STAFF" ? "ACCOUNT_LOCKOUT" : "ATTENDEE_LOCKOUT";
  const when = formatLockoutTime(input.now, settings.defaultTimezone);
  const correlationId = randomUUID();
  const messageIds: string[] = [];

  if (personDue) {
    const personEmail = personBody({
      audience: input.audience,
      kind: input.kind,
      displayName: person.displayName,
      when,
    });
    const idempotencyKey = capKey(personPrefix, input.now, PERSON_EMAIL_WINDOW_MS);
    const personMessage = await client.messageOutbox.upsert({
      where: { idempotencyKey },
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
        idempotencyKey,
        correlationId,
        status: "PENDING",
      },
      select: { id: true },
    });
    messageIds.push(personMessage.id);
  }

  if (officeDue && settings.securityAlertEmail) {
    const office = officeBody({
      kind: input.kind,
      audience: input.audience,
      accountEmail: person.email,
      when,
    });
    const idempotencyKey = capKey(officePrefix, input.now, OFFICE_ALERT_WINDOW_MS);
    const officeMessage = await client.messageOutbox.upsert({
      where: { idempotencyKey },
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
        idempotencyKey,
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
 * Queues the lockout email(s), within the per-account cap, and makes a
 * best-effort attempt to deliver them immediately, exactly like an account
 * password-reset email. Never throws. Runs only after the response — call it
 * through {@link scheduleLockoutEmails}, never from a request path directly.
 * Nothing here touches the database on a deployment that cannot send email.
 */
export async function dispatchLockoutEmails(input: LockoutEmailInput): Promise<void> {
  if (!isAccountEmailConfigured()) return;
  try {
    const messageIds = await enqueueLockoutEmails(getPrisma(), input);
    if (messageIds.length > 0) {
      await processAccountEmailQueue({ messageIds });
    }
  } catch (error) {
    logError("A lockout email could not be queued or sent.", error, {
      audience: input.audience,
      kind: input.kind,
    });
  }
}

/** Runs a task once the response has been sent. Defaults to Next.js `after`. */
export type LockoutEmailScheduler = (task: () => Promise<void>) => void;

/**
 * The only entry point for sign-in code paths. Schedules both the enqueue and
 * the delivery to run after the response, so the locking attempt answers in
 * the same time and the same words as any other failure. Synchronous and
 * never throws: if there is no request scope to schedule into, the lock still
 * stands and only the email is lost (logged).
 */
export function scheduleLockoutEmails(
  input: LockoutEmailInput,
  schedule: LockoutEmailScheduler = after,
): void {
  try {
    schedule(() => dispatchLockoutEmails(input));
  } catch (error) {
    logError("A lockout email could not be scheduled.", error, {
      audience: input.audience,
      kind: input.kind,
    });
  }
}
