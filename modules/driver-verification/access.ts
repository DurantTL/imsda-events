import "server-only";

import { getPrisma } from "@/lib/prisma";
import type { ClubActor } from "@/modules/club-rosters/access";
import { requireClubCapability } from "@/modules/club-rosters/access";
import { requireSystemAdministrator } from "@/modules/organizations/access";

/**
 * Who may review the driver verification queue (#491, decision recorded
 * here): conference staff (a system administrator) get the global queue
 * across every club; a club's own director or deputy get a queue scoped to
 * their club's current roster only — the same leader-only capability
 * (`manageTeam`) that already gates managing a club's team, so a registrar
 * or reporter never reaches it. Both are "conference or club staff" per the
 * issue. A club director/deputy can only review their own club's willing
 * drivers, never another club's.
 */

export type GlobalReviewerActor = { userId: string };

export async function requireGlobalDriverReviewAccess(): Promise<GlobalReviewerActor> {
  const user = await requireSystemAdministrator();
  return { userId: user.id };
}

export async function requireClubDriverReviewAccess(organizationId: string) {
  return requireClubCapability(organizationId, "manageTeam");
}

/** Either identity a reviewer or a roster actor can be, for self-nomination and attribution. */
export type ActorIdentity = { accountId: string } | { userId: string };

export function actorIdentity(actor: ClubActor | GlobalReviewerActor): ActorIdentity {
  return "accountId" in actor ? { accountId: actor.accountId } : { userId: actor.userId };
}

/**
 * The `Person` this actor is themself known to be, if any (`UserPersonLink`
 * for a staff account, `AttendeeAccountPersonLink` for an attendee account).
 * Null when the actor has no such link, which is never mistaken for a match
 * against a real roster row's `personId` (`isSelfNomination`).
 */
export async function personIdForActor(identity: ActorIdentity): Promise<string | null> {
  const prisma = getPrisma();
  if ("accountId" in identity) {
    const link = await prisma.attendeeAccountPersonLink.findUnique({
      where: { accountId: identity.accountId },
      select: { personId: true },
    });
    return link?.personId ?? null;
  }
  const link = await prisma.userPersonLink.findUnique({
    where: { userId: identity.userId },
    select: { personId: true },
  });
  return link?.personId ?? null;
}
