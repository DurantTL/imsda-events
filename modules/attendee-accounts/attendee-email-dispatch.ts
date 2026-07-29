import "server-only";

import { logError, logInfo } from "@/lib/logger";
import { processAccountEmailQueue } from "@/modules/communications/email-delivery";
import {
  enqueueAttendeeEmail,
  isAttendeeEmailConfigured,
} from "@/modules/attendee-accounts/attendee-email";

/**
 * Queues an attendee email and tries to deliver it in the same request, the way
 * an account activation is. A failure here is not the caller's to handle: the
 * message keeps its place in the outbox with its backoff, and the scheduled
 * sweep picks it up.
 *
 * Separate from `attendee-email` for the reason `account-email-dispatch` is
 * separate from `account-email`: the delivery worker already depends on the
 * content module, so the content module must not depend on the worker.
 */

export type AttendeeEmailDispatch = {
  /** Whether this deployment can send account email at all. */
  configured: boolean;
};

async function dispatch(input: Parameters<typeof enqueueAttendeeEmail>[0]) {
  if (!isAttendeeEmailConfigured()) return { configured: false };

  const { messageId } = await enqueueAttendeeEmail(input);
  try {
    const result = await processAccountEmailQueue({ messageIds: [messageId], limit: 1 });
    if (result.sentIds.length === 0) {
      logInfo("An attendee email was queued but not sent on the first attempt.", {
        messageId,
        rescheduled: result.rescheduledIds.length > 0,
      });
    }
  } catch (error) {
    // Queued is what matters. The sweep will try again.
    logError("An attendee email could not be delivered immediately.", error, { messageId });
  }
  return { configured: true };
}

export async function sendAttendeeVerificationEmail(input: {
  accountId: string;
  email: string;
  displayName: string;
  alreadyRegistered: boolean;
}): Promise<AttendeeEmailDispatch> {
  return dispatch({
    accountId: input.accountId,
    email: input.email,
    displayName: input.displayName,
    selection: { kind: "verification", alreadyRegistered: input.alreadyRegistered },
  });
}

export async function sendAttendeePasswordResetEmail(input: {
  accountId: string;
  email: string;
  displayName: string;
  federatedOnly: boolean;
}): Promise<AttendeeEmailDispatch> {
  return dispatch({
    accountId: input.accountId,
    email: input.email,
    displayName: input.displayName,
    selection: { kind: "password-reset", federatedOnly: input.federatedOnly },
  });
}
