import "server-only";

import { getPrisma } from "@/lib/prisma";
import { requireRosterAccess } from "@/modules/club-rosters/access";
import { requireSystemAdministrator } from "@/modules/organizations/access";

/**
 * Who may see and change driver clearance (#544, replacing the #491 review
 * queue). Clearance itself is derived from the background-check list; nobody
 * reviews it by default.
 *
 * - Staff overrides and the exceptions queue: a system administrator only.
 * - A club's own driver list: its director or deputy (`manageTeam`, the same
 *   leader-only capability that manages the club's team), for their own club
 *   only. It carries clearance labels and nothing else, and a club can't
 *   override clearance.
 */

export type GlobalReviewerActor = { userId: string };

export async function requireGlobalDriverReviewAccess(): Promise<GlobalReviewerActor> {
  const user = await requireSystemAdministrator();
  return { userId: user.id };
}

/**
 * A club's driver list sits behind the roster's own gate, not just a club
 * role: the person's own attendee session, an authenticator or passkey set up
 * (MFA_SETUP), and a second step within the last `ROSTER_UNLOCK_HOURS`
 * (MFA_UNLOCK). Another club (or one the person doesn't lead) is a 404, never
 * a hint it exists; a registrar or reporter is a 403 (`manageTeam`).
 */
export async function requireClubDriverReviewAccess(organizationId: string, now = new Date()) {
  return requireRosterAccess(organizationId, now, "manageTeam");
}

/**
 * The `Person` this staff account is itself known to be, if any
 * (`UserPersonLink`). Null when there is no such link, which is never
 * mistaken for a match against a real roster row's `personId`.
 *
 * Known limitation (open for a human): self-review is only detected through
 * that link. A reviewer whose own roster row was typed in by hand and never
 * linked to their account has a different `Person`, so overriding that row
 * isn't recognised as overriding themself. Matching by name or email would be
 * identity merging, which is a human-only decision, so it isn't attempted.
 */
export async function personIdForActor(identity: GlobalReviewerActor): Promise<string | null> {
  const link = await getPrisma().userPersonLink.findUnique({
    where: { userId: identity.userId },
    select: { personId: true },
  });
  return link?.personId ?? null;
}
