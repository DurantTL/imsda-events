import "server-only";

import { createHash } from "node:crypto";
import { normalizeNotificationEmail, normalizeTransferName } from "@/modules/club-transfers/domain";

/** Hashed keys for club member transfers (#489): server-only, since they use node:crypto. */

/**
 * One open request per receiving club, sending club, and typed name. Stored
 * hashed so the unique key itself never spells a name.
 */
export function transferRequestKey(input: {
  toOrganizationId: string;
  fromOrganizationId: string;
  firstName: string;
  lastName: string;
}) {
  return createHash("sha256")
    .update([
      input.toOrganizationId,
      input.fromOrganizationId,
      normalizeTransferName(input.firstName),
      normalizeTransferName(input.lastName),
    ].join("\u0000"))
    .digest("hex");
}

/**
 * The outbox idempotency key for one transfer notice: never a raw email.
 * An account recipient is keyed by account id; a guest (the member's own
 * email on file) by a hash of the normalized address.
 */
export function transferNotificationKey(
  transferId: string,
  templateKey: string,
  recipient: { accountId?: string | null; email: string },
) {
  const who = recipient.accountId
    ? `account:${recipient.accountId}`
    : `email:${createHash("sha256").update(normalizeNotificationEmail(recipient.email)).digest("hex").slice(0, 32)}`;
  return `member-transfer:${transferId}:${templateKey}:${who}`;
}
