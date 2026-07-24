import "server-only";

import { getPrisma } from "@/lib/prisma";
import { logError, logInfo } from "@/lib/logger";
import {
  enqueueAccountEmail,
  isAccountEmailConfigured,
  type AccountEmailPurpose,
} from "@/modules/communications/account-email";
import { processAccountEmailQueue } from "@/modules/communications/email-delivery";

/**
 * Queues account email and tries to deliver it in the same request, the way a
 * registration confirmation is delivered after commit. A failure here is not an
 * error the caller has to handle: the message stays in the outbox with its
 * backoff, and the scheduled sweep picks it up.
 *
 * This module exists to keep `account-email` free of a dependency on the
 * delivery worker, which already depends on it.
 */

export type AccountEmailDispatch = {
  /** Whether this deployment can send account email at all. */
  configured: boolean;
  /** Whether a message was queued — false for an unknown or disabled account. */
  queued: boolean;
};

async function dispatch(input: {
  userId: string;
  email: string;
  displayName: string;
  purpose: AccountEmailPurpose;
  requestKey?: string;
}): Promise<AccountEmailDispatch> {
  const { messageId } = await enqueueAccountEmail(input);
  try {
    const result = await processAccountEmailQueue({
      messageIds: [messageId],
      limit: 1,
    });
    if (result.sentIds.length === 0) {
      logInfo("Account email was queued but not sent on the first attempt.", {
        messageId,
        purpose: input.purpose,
        rescheduled: result.rescheduledIds.length > 0,
      });
    }
  } catch (error) {
    // Queued is what matters. The sweep will try again.
    logError("Account email could not be delivered immediately.", error, {
      messageId,
      purpose: input.purpose,
    });
  }
  return { configured: true, queued: true };
}

/**
 * Emails a password reset or, for an account that has never been activated, an
 * activation link. Says nothing about whether the address is known: an unknown
 * or disabled account queues nothing and reports the same shape.
 */
export async function sendAccountRecoveryEmail(
  email: string,
): Promise<AccountEmailDispatch> {
  if (!isAccountEmailConfigured()) return { configured: false, queued: false };

  const normalizedEmail = email.trim().toLowerCase();
  const user = await getPrisma().user.findUnique({
    where: { email: normalizedEmail },
    select: {
      id: true,
      displayName: true,
      accountStatus: true,
      credential: { select: { disabledAt: true } },
    },
  });
  if (!user?.credential || user.credential.disabledAt) {
    return { configured: true, queued: false };
  }

  return dispatch({
    userId: user.id,
    email: normalizedEmail,
    displayName: user.displayName,
    purpose: user.accountStatus === "PENDING_ACTIVATION"
      ? "ACCOUNT_ACTIVATION"
      : "PASSWORD_RESET",
  });
}

/**
 * Emails the activation link for a colleague who has just been invited, so the
 * administrator who invited them does not have to hand a link over in person.
 */
export async function sendStaffInvitationEmail(input: {
  userId: string;
  email: string;
  displayName: string;
}): Promise<AccountEmailDispatch> {
  if (!isAccountEmailConfigured()) return { configured: false, queued: false };

  return dispatch({ ...input, purpose: "ACCOUNT_ACTIVATION" });
}
