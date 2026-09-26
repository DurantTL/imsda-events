import "server-only";

import { getPrisma } from "@/lib/prisma";

/**
 * Staff and attendee accounts stay separate (#442 decision): a system
 * administrator acting as a club's director may give club team roles the way
 * a real director would, but never to their own email — that would hand
 * their own attendee account a club role through the act-as.
 */
export const ACT_AS_OWN_ACCOUNT_MESSAGE =
  "While acting as a club director you can't give a club role to your own email or attendee account. Ask the club's director, or use the staff tools.";

/** True when `actor` is a staff act-as and `email` is that staff member's own email. */
export async function isActingAdminsOwnEmail(
  actor: { accountId: string } | { userId: string; actAsId?: string },
  email: string,
) {
  if (!("userId" in actor)) return false;
  const user = await getPrisma().user.findUnique({ where: { id: actor.userId }, select: { email: true } });
  return Boolean(user && user.email.trim().toLowerCase() === email.trim().toLowerCase());
}
