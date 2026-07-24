import "server-only";

import { randomUUID } from "node:crypto";
import type { AccountTokenPurpose, Prisma } from "@prisma/client";
import { getServerEnv } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import {
  ACTIVATION_LIFETIME_MINUTES,
  RESET_LIFETIME_MINUTES,
  issueAccountTokenForUser,
  revokeAccountToken,
} from "@/modules/access/auth-service";
import { getResendEmailAvailability } from "@/integrations/email/resend";

/**
 * Activation and password reset email.
 *
 * These belong to a person rather than to an event, which is why they could not
 * previously use the outbox: every row had to name an event and take its sender
 * identity from that event's settings. They now travel the same path as
 * registration email — backoff, attempt history, provider events, and the
 * scheduled sweep — with `eventId` null and a sender taken from the
 * `ACCOUNT_EMAIL_*` variables.
 *
 * The body carries a sentinel, never a token. The one-time link is minted at
 * delivery, exactly as a private registration link is, so a database read never
 * yields a usable credential and a reset link's thirty minutes start when it is
 * sent rather than when it is queued.
 */

export const ACCOUNT_ACTION_LINK_SENTINEL = "{{account_action_link}}";

export type AccountEmailPurpose = AccountTokenPurpose;

export type AccountEmailSender = {
  name: string;
  address: string;
  replyTo: string | null;
};

export class AccountEmailNotConfiguredError extends Error {
  readonly code = "ACCOUNT_EMAIL_NOT_CONFIGURED";

  constructor(message: string) {
    super(message);
    this.name = "AccountEmailNotConfiguredError";
  }
}

/**
 * Whether an account email can actually leave the building. Production requires
 * both halves at startup; this exists for development, where the honest answer
 * has to be shown to the person who would otherwise wait for an email that is
 * never sent.
 */
export function isAccountEmailConfigured() {
  const env = getServerEnv();
  return Boolean(env.ACCOUNT_EMAIL_SENDER_ADDRESS)
    && getResendEmailAvailability().deliveryConfigured;
}

export function getAccountEmailSender(): AccountEmailSender {
  const env = getServerEnv();
  if (!env.ACCOUNT_EMAIL_SENDER_ADDRESS) {
    throw new AccountEmailNotConfiguredError(
      "Set ACCOUNT_EMAIL_SENDER_ADDRESS before account email can be sent.",
    );
  }
  return {
    name: env.ACCOUNT_EMAIL_SENDER_NAME,
    address: env.ACCOUNT_EMAIL_SENDER_ADDRESS,
    replyTo: env.ACCOUNT_EMAIL_REPLY_TO ?? null,
  };
}

function describeLifetime(minutes: number) {
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minutes`;
}

export function accountEmailContent(
  purpose: AccountEmailPurpose,
  input: { displayName: string },
) {
  const name = input.displayName.trim() || "there";
  if (purpose === "ACCOUNT_ACTIVATION") {
    return {
      templateKey: "ACCOUNT_ACTIVATION" as const,
      subject: "Set up your IMSDA Events account",
      bodyText: [
        `Hello ${name},`,
        "",
        "An IMSDA Events account has been created for you. Choose a password to activate it:",
        "",
        ACCOUNT_ACTION_LINK_SENTINEL,
        "",
        `This link works once and expires in ${describeLifetime(ACTIVATION_LIFETIME_MINUTES)}.`,
        "If it has expired, use \"Forgot password\" on the sign-in page to request another.",
        "",
        "If you were not expecting this, you can ignore it — the account cannot be used until a password is set.",
        "",
        "IMSDA Events",
      ].join("\n"),
    };
  }
  return {
    templateKey: "ACCOUNT_PASSWORD_RESET" as const,
    subject: "Reset your IMSDA Events password",
    bodyText: [
      `Hello ${name},`,
      "",
      "Someone asked to reset the password for this IMSDA Events account. Choose a new one here:",
      "",
      ACCOUNT_ACTION_LINK_SENTINEL,
      "",
      `This link works once and expires in ${describeLifetime(RESET_LIFETIME_MINUTES)}.`,
      "",
      "If you did not ask for this, no action is needed — your current password still works and this link can only be used by whoever opens it first.",
      "",
      "IMSDA Events",
    ].join("\n"),
  };
}

export type EnqueuedAccountEmail = {
  messageId: string;
  purpose: AccountEmailPurpose;
};

/**
 * Queues one account email. Callers must have established that the account
 * exists and is not disabled — this does not decide who deserves a link.
 */
export async function enqueueAccountEmail(input: {
  userId: string;
  email: string;
  displayName: string;
  purpose: AccountEmailPurpose;
  correlationId?: string;
  requestKey?: string;
}): Promise<EnqueuedAccountEmail> {
  const sender = getAccountEmailSender();
  const content = accountEmailContent(input.purpose, { displayName: input.displayName });
  const message = await getPrisma().messageOutbox.create({
    data: {
      eventId: null,
      accountUserId: input.userId,
      templateKey: content.templateKey,
      recipientKind: "ACCOUNT",
      recipientEmail: input.email.trim().toLowerCase(),
      recipientName: input.displayName.trim() || null,
      senderNameSnapshot: sender.name,
      senderEmailSnapshot: sender.address,
      replyToEmailSnapshot: sender.replyTo,
      subjectSnapshot: content.subject,
      bodyTextSnapshot: content.bodyText,
      metadata: {
        trigger: input.purpose === "ACCOUNT_ACTIVATION"
          ? "STAFF_INVITATION"
          : "PASSWORD_RESET_REQUESTED",
        accountEmail: true,
        realDelivery: true,
      } satisfies Prisma.InputJsonValue,
      // One row per request, not per address: a person who asks twice gets two
      // emails, and the newest link retires the previous one when it is minted.
      idempotencyKey: `account:${input.purpose}:${input.requestKey ?? randomUUID()}`,
      correlationId: input.correlationId ?? randomUUID(),
      status: "PENDING",
    },
    select: { id: true },
  });
  return { messageId: message.id, purpose: input.purpose };
}

/**
 * Mints the one-time link at delivery. Mirrors
 * `prepareEmailBodyForDelivery` for private registration links: the token is
 * created when the message is actually sent, and retired again if that attempt
 * fails definitively, so no unusable link is left live.
 */
export async function prepareAccountEmailBodyForDelivery(input: {
  messageId: string;
  accountUserId: string | null;
  templateKey: string;
  bodyText: string;
  now: Date;
}) {
  if (!input.bodyText.includes(ACCOUNT_ACTION_LINK_SENTINEL)) {
    return { bodyText: input.bodyText };
  }
  if (!input.accountUserId) {
    throw new Error("An account message cannot mint a one-time link without an account.");
  }

  const purpose: AccountEmailPurpose = input.templateKey === "ACCOUNT_ACTIVATION"
    ? "ACCOUNT_ACTIVATION"
    : "PASSWORD_RESET";
  const issued = await issueAccountTokenForUser(input.accountUserId, {
    purpose,
    now: input.now,
  });
  const actionUrl = new URL(
    `/reset-password?token=${encodeURIComponent(issued.token)}`,
    getServerEnv().APP_BASE_URL,
  ).toString();

  return {
    bodyText: input.bodyText.replaceAll(ACCOUNT_ACTION_LINK_SENTINEL, actionUrl),
    revokeOnDefinitiveFailure: async () => {
      await revokeAccountToken(issued.token, input.now);
    },
  };
}
