import "server-only";

import { actorAttribution, requireRosterAccess, type ClubActor } from "@/modules/club-rosters/access";
import { requireSystemAdministrator } from "@/modules/organizations/access";

/**
 * Who may work with club member transfers (#489):
 *
 * - A receiving club's director or deputy requests a transfer, and a
 *   sending club's director or deputy accepts, declines, or cancels one.
 *   Both are the roster's own `manageTeam` capability (directors and
 *   deputies only; a registrar keeps the roster but not this) behind the
 *   same roster gate as everything else that touches a roster row
 *   (`requireRosterAccess`: own attendee session, MFA set up and unlocked).
 * - Conference staff (a system administrator) see the transfer queue and
 *   the registration-move approval list, and finish, override, or close
 *   any transfer regardless of club.
 */
export async function requireClubTransferAccess(organizationId: string, now = new Date()) {
  return requireRosterAccess(organizationId, now, "manageTeam");
}

export type StaffTransferActor = { userId: string };

export async function requireStaffTransferAccess(): Promise<StaffTransferActor> {
  const user = await requireSystemAdministrator();
  return { userId: user.id };
}

/** Either identity a club actor or a staff actor can be, for attribution. */
export type TransferActor = ClubActor | StaffTransferActor;

/** Never an attendee account credited for a staff action (#442): a plain staff actor attributes to `userId` alone, with no `actAsId`. */
export function transferActorAttribution(actor: TransferActor): { accountId: string } | { userId: string; actAsId?: string } {
  return "kind" in actor ? actorAttribution(actor) : { userId: actor.userId };
}

/** Who a transfer request is rate-limited as: the attendee account, or the staff user acting as director. */
export function transferRateLimitKey(actor: TransferActor) {
  const attribution = transferActorAttribution(actor);
  return "accountId" in attribution ? `account:${attribution.accountId}` : `user:${attribution.userId}`;
}
