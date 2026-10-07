import "server-only";

import { logError } from "@/lib/logger";
import { isAccountEmailConfigured } from "@/modules/communications/account-email";
import { processAccountEmailQueue } from "@/modules/communications/email-delivery";

/** Best-effort delivery after the transaction commits. Never throws; the outbox sweep retries what fails. */
export async function deliverApplicationEmails(messageIds: readonly string[]): Promise<void> {
  if (messageIds.length === 0 || !isAccountEmailConfigured()) return;
  try {
    await processAccountEmailQueue({ messageIds: [...messageIds] });
  } catch (error) {
    logError("A new club application email could not be delivered now.", error, { count: messageIds.length });
  }
}
