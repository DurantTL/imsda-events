import "server-only";

import { hashOpaqueToken } from "@/modules/access/tokens";
import { getPrisma } from "@/lib/prisma";
import {
  isHostedReturnId,
  maskConfirmationCode,
  type HostedReturnStatus,
} from "@/modules/payments/hosted-return-presentation";

/**
 * The status behind Square's return link (#327). The return id is a capability for this one view:
 * it answers "has the payment been confirmed" and shows the registration's masked confirmation
 * code, and nothing else. It never opens the registration, so it is safe to hand to Square.
 *
 * Confirmation comes only from the server's own record, which is written from the verified
 * webhook; arriving here proves nothing. An unknown or expired id is `null` (a 404 to the caller),
 * the same answer for both so ids cannot be probed.
 */
export async function getHostedReturnStatus(
  returnId: string,
  options: { now?: Date } = {},
): Promise<HostedReturnStatus | null> {
  if (!isHostedReturnId(returnId)) return null;
  const now = options.now ?? new Date();
  const hosted = await getPrisma().squareHostedCheckout.findUnique({
    where: { returnTokenHash: hashOpaqueToken(returnId) },
    select: {
      returnExpiresAt: true,
      registration: { select: { confirmationCode: true } },
      paymentAttempt: {
        select: {
          status: true,
          duplicateReason: true,
          _count: {
            select: { duplicateCharges: { where: { status: "OPEN" } } },
          },
        },
      },
    },
  });
  if (!hosted || !hosted.returnExpiresAt || hosted.returnExpiresAt <= now) return null;
  const attempt = hosted.paymentAttempt;
  // Held whenever staff still have an exception open for this link (a duplicate, a second payment
  // on the order, a split payment), and for good once the attempt itself was the held payment.
  const held = attempt.duplicateReason !== null || attempt._count.duplicateCharges > 0;
  return {
    state: held ? "HELD" : attempt.status === "SUCCEEDED" ? "CONFIRMED" : "CONFIRMING",
    maskedConfirmationCode: maskConfirmationCode(hosted.registration.confirmationCode),
  };
}
