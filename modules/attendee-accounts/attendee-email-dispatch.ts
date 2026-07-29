import "server-only";

import { logError, logInfo } from "@/lib/logger";
import { processAccountEmailQueue } from "@/modules/communications/email-delivery";
import {
  enqueueAttendeeEmail,
  isAttendeeEmailConfigured,
} from "@/modules/attendee-accounts/attendee-email";
import { bindAttendeeStepUpMessage } from "@/modules/attendee-accounts/step-up-service";

/**
 * Queues attendee email separately from delivering it.
 *
 * Public password-reset responses must not wait on a provider request only for
 * known addresses: doing that turns Resend and database latency into an account
 * enumeration oracle. Route handlers queue the immutable row, return their
 * deliberately identical response, and use Next.js `after()` to call
 * {@link deliverQueuedAttendeeEmail}. The scheduled sweep remains the durable
 * fallback if that best-effort first delivery does not run.
 *
 * Separate from `attendee-email` for the reason `account-email-dispatch` is
 * separate from `account-email`: the delivery worker already depends on the
 * content module, so the content module must not depend on the worker.
 */

export type AttendeeEmailDispatch = {
  /** Whether this deployment can send account email at all. */
  configured: boolean;
  /** Present when a durable outbox row was created. */
  messageId: string | null;
};

async function queue(input: Parameters<typeof enqueueAttendeeEmail>[0]) {
  if (!isAttendeeEmailConfigured()) return { configured: false, messageId: null };

  const { messageId } = await enqueueAttendeeEmail(input);
  return { configured: true, messageId };
}

export async function deliverQueuedAttendeeEmail(messageId: string) {
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
    logError("An attendee email could not be delivered after the response.", error, { messageId });
  }
}

export async function queueAttendeeVerificationEmail(input: {
  accountId: string;
  email: string;
  displayName: string;
  alreadyRegistered: boolean;
}): Promise<AttendeeEmailDispatch> {
  return queue({
    accountId: input.accountId,
    email: input.email,
    displayName: input.displayName,
    selection: { kind: "verification", alreadyRegistered: input.alreadyRegistered },
  });
}

export async function queueAttendeePasswordResetEmail(input: {
  accountId: string;
  email: string;
  displayName: string;
  federatedOnly: boolean;
}): Promise<AttendeeEmailDispatch> {
  return queue({
    accountId: input.accountId,
    email: input.email,
    displayName: input.displayName,
    selection: { kind: "password-reset", federatedOnly: input.federatedOnly },
  });
}

export async function queueAttendeeEditVerificationEmail(input: {
  accountId: string;
  stepUpCodeId: string;
  email: string;
  displayName: string;
}): Promise<AttendeeEmailDispatch> {
  const dispatch = await queue({
    accountId: input.accountId,
    email: input.email,
    displayName: input.displayName,
    selection: { kind: "edit-verification" },
  });
  if (
    dispatch.messageId
    && !await bindAttendeeStepUpMessage(input.stepUpCodeId, dispatch.messageId)
  ) {
    throw new Error("The edit verification message could not be bound to its session.");
  }
  return dispatch;
}
