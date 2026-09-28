import "server-only";

import { getPrisma } from "@/lib/prisma";
import type { ClubActor } from "@/modules/club-rosters/access";
import { requireRosterAccess } from "@/modules/club-rosters/access";
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

/**
 * A club's queue sits behind the roster's own gate, not just a club role:
 * the person's own attendee session, an authenticator or passkey set up
 * (MFA_SETUP), and a second step within the last `ROSTER_UNLOCK_HOURS`
 * (MFA_UNLOCK) — it lists roster members' background-check status. Another
 * club (or one the person doesn't lead) is a 404, never a hint it exists;
 * a registrar or reporter is a 403 (`manageTeam`).
 */
export async function requireClubDriverReviewAccess(organizationId: string, now = new Date()) {
  return requireRosterAccess(organizationId, now, "manageTeam");
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
 *
 * Known limitation (open for a human, #491): self-review is only detected
 * through those links. A director whose own roster row was typed in by hand
 * and never linked to their account has a different `Person`, so clearing
 * that row isn't recognised as clearing themself. Matching by name or email
 * would be identity merging, which is a human-only decision, so it isn't
 * attempted here. Likewise open: a clearance is stored per person, not per
 * club, so a person on two clubs' rosters cleared by one club's director
 * shows as cleared on the other club's queue too.
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
