import "server-only";

import { getPrisma } from "@/lib/prisma";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { passkeysConfigured } from "@/modules/attendee-accounts/passkeys";
import { currentStaffActingContext } from "@/modules/organizations/staff-act-as";
import { listDirectedClubs, type DirectedClub } from "@/modules/organizations/director-access";
import { clubCapabilities, type ClubCapabilities } from "@/modules/organizations/director-grants-domain";

/**
 * Who may open a club roster (ADR 0005 Addendum A): only someone whose
 * current club role includes the roster (director, deputy, or registrar,
 * #375), signed in with their own attendee session, with an authenticator or
 * passkey set up and used during this session. A reporter reaches the club
 * but never the roster, and needs no second step for that.
 *
 * A system administrator "acting as" a club's director (#442) resolves
 * differently: the staff session's active act-as decides, scoped to that one
 * organization, with full director capabilities and no attendee MFA gate —
 * it never reaches for an attendee account at all. It is checked first; an
 * attendee session (if any, on the same browser) is only consulted when
 * there is no active club-director act-as for this club.
 */

export const ROSTER_UNLOCK_HOURS = 12;

/** Who is acting, for attribution: an attendee themself, or staff acting as a club's director. */
export type ClubActor =
  | { kind: "ATTENDEE"; accountId: string; sessionId: string }
  | { kind: "STAFF_ACTING"; userId: string; staffSessionId: string; actAsId: string; organizationId: string };

/** Attribution fields for a repository write: never both, and staff acting never yields an accountId. */
export function actorAttribution(actor: ClubActor): { accountId: string } | { userId: string; actAsId: string } {
  return actor.kind === "ATTENDEE"
    ? { accountId: actor.accountId }
    : { userId: actor.userId, actAsId: actor.actAsId };
}

export type RosterAccessState =
  | { state: "SIGN_IN" }
  | { state: "NOT_FOUND" }
  | { state: "NO_ROSTER"; club: DirectedClub; capabilities: ClubCapabilities }
  | { state: "OWN_SESSION_REQUIRED"; club: DirectedClub }
  | { state: "MFA_SETUP"; club: DirectedClub }
  | { state: "MFA_UNLOCK"; club: DirectedClub; methods: { code: boolean; passkey: boolean } }
  | { state: "OPEN"; club: DirectedClub; capabilities: ClubCapabilities; actor: ClubActor };

export async function getRosterAccessState(organizationId: string, now = new Date()): Promise<RosterAccessState> {
  const acting = await currentStaffActingContext();
  if (acting && acting.role === "CLUB_DIRECTOR" && acting.organizationId === organizationId) {
    const club = await getPrisma().organization.findUnique({
      where: { id: organizationId },
      select: { type: true, isActive: true, name: true, parentOrganization: { select: { name: true } } },
    });
    if (club && club.type === "CLUB" && club.isActive) {
      return {
        state: "OPEN",
        club: { organizationId, name: club.name, role: "DIRECTOR", sponsoringChurch: club.parentOrganization?.name ?? null },
        capabilities: clubCapabilities("DIRECTOR"),
        actor: { kind: "STAFF_ACTING", userId: acting.userId, staffSessionId: acting.staffSessionId, actAsId: acting.actAsId, organizationId },
      };
    }
    return { state: "NOT_FOUND" };
  }

  const { account, via, sessionId } = await getCurrentAttendee();
  if (!account) return { state: "SIGN_IN" };
  const club = (await listDirectedClubs(account.id, now))
    .find((candidate) => candidate.organizationId === organizationId);
  if (!club) return { state: "NOT_FOUND" };
  const capabilities = clubCapabilities(club.role);
  if (!capabilities.roster) return { state: "NO_ROSTER", club, capabilities };
  if (via !== "attendee" || !sessionId) return { state: "OWN_SESSION_REQUIRED", club };

  const [enrollment, passkeyCount, session, passkeysOn] = await Promise.all([
    getPrisma().attendeeMfaEnrollment.findUnique({ where: { accountId: account.id }, select: { status: true } }),
    getPrisma().attendeePasskey.count({ where: { accountId: account.id, revokedAt: null } }),
    getPrisma().attendeeSession.findUnique({ where: { id: sessionId }, select: { secondFactorVerifiedAt: true } }),
    passkeysConfigured(),
  ]);
  // An authenticator app or a passkey (once passkeys are switched on) is the second step.
  const methods = { code: enrollment?.status === "ACTIVE", passkey: passkeysOn && passkeyCount > 0 };
  if (!methods.code && !methods.passkey) return { state: "MFA_SETUP", club };
  const verifiedAt = session?.secondFactorVerifiedAt;
  if (!verifiedAt || now.getTime() - verifiedAt.getTime() > ROSTER_UNLOCK_HOURS * 3_600_000) {
    return { state: "MFA_UNLOCK", club, methods };
  }
  return { state: "OPEN", club, capabilities, actor: { kind: "ATTENDEE", accountId: account.id, sessionId } };
}

export class RosterAccessError extends Error {
  constructor(
    public readonly code:
      | "SIGN_IN_REQUIRED"
      | "NOT_FOUND"
      | "ROLE_NOT_ALLOWED"
      | "OWN_SESSION_REQUIRED"
      | "MFA_SETUP_REQUIRED"
      | "MFA_UNLOCK_REQUIRED",
    public readonly status: 401 | 403 | 404,
    message: string,
  ) {
    super(message);
    this.name = "RosterAccessError";
  }
}

/**
 * For API routes: the open roster, or an error that never reveals another
 * club. `need` names a capability beyond the roster itself (for example
 * `manageTeam`); a role without it gets 403.
 */
export async function requireRosterAccess(
  organizationId: string,
  now = new Date(),
  need?: Exclude<keyof ClubCapabilities, "roster">,
) {
  const access = await getRosterAccessState(organizationId, now);
  switch (access.state) {
    case "OPEN":
      if (need && !access.capabilities[need]) {
        throw new RosterAccessError("ROLE_NOT_ALLOWED", 403, "Your club role doesn't include this. Ask your club director.");
      }
      return access;
    case "NO_ROSTER":
      throw new RosterAccessError("ROLE_NOT_ALLOWED", 403, "Your club role doesn't include the roster. Ask your club director.");
    case "SIGN_IN":
      throw new RosterAccessError("SIGN_IN_REQUIRED", 401, "Sign in to open your club roster.");
    case "NOT_FOUND":
      throw new RosterAccessError("NOT_FOUND", 404, "That club could not be found.");
    case "OWN_SESSION_REQUIRED":
      throw new RosterAccessError("OWN_SESSION_REQUIRED", 403, "Sign in with your own attendee account to open the roster.");
    case "MFA_SETUP":
      throw new RosterAccessError("MFA_SETUP_REQUIRED", 403, "Set up an authenticator or passkey on your account before opening the roster.");
    case "MFA_UNLOCK":
      throw new RosterAccessError("MFA_UNLOCK_REQUIRED", 403, "Confirm it's you with your authenticator code or passkey to open the roster.");
  }
}

/** Records that this session passed the authenticator check. */
export async function markRosterUnlocked(sessionId: string, now = new Date()) {
  await getPrisma().attendeeSession.update({
    where: { id: sessionId },
    data: { secondFactorVerifiedAt: now },
  });
}

export type ClubRoleAccess =
  | { state: "SIGN_IN" }
  | { state: "NOT_FOUND" }
  | { state: "OWN_SESSION_REQUIRED"; club: DirectedClub; capabilities: ClubCapabilities }
  | { state: "OK"; club: DirectedClub; capabilities: ClubCapabilities; actor: ClubActor };

/**
 * Club screens that hold no birth dates (monthly reports, #377) need the
 * person's own sign-in and a club role, but not the second step the roster
 * needs. A staff "act as" director (#442) resolves the same way as
 * `getRosterAccessState`: the active act-as decides first, scoped to its one
 * club, with no attendee MFA gate.
 */
export async function getClubRoleAccess(organizationId: string, now = new Date()): Promise<ClubRoleAccess> {
  const acting = await currentStaffActingContext();
  if (acting && acting.role === "CLUB_DIRECTOR" && acting.organizationId === organizationId) {
    const club = await getPrisma().organization.findUnique({
      where: { id: organizationId },
      select: { type: true, isActive: true, name: true, parentOrganization: { select: { name: true } } },
    });
    if (club && club.type === "CLUB" && club.isActive) {
      return {
        state: "OK",
        club: { organizationId, name: club.name, role: "DIRECTOR", sponsoringChurch: club.parentOrganization?.name ?? null },
        capabilities: clubCapabilities("DIRECTOR"),
        actor: { kind: "STAFF_ACTING", userId: acting.userId, staffSessionId: acting.staffSessionId, actAsId: acting.actAsId, organizationId },
      };
    }
    return { state: "NOT_FOUND" };
  }

  const { account, via, sessionId } = await getCurrentAttendee();
  if (!account) return { state: "SIGN_IN" };
  const club = (await listDirectedClubs(account.id, now)).find((candidate) => candidate.organizationId === organizationId);
  if (!club) return { state: "NOT_FOUND" };
  const capabilities = clubCapabilities(club.role);
  if (via !== "attendee" || !sessionId) return { state: "OWN_SESSION_REQUIRED", club, capabilities };
  return { state: "OK", club, capabilities, actor: { kind: "ATTENDEE", accountId: account.id, sessionId } };
}

/** For API routes: the club role with `need`, or an error that never reveals another club. */
export async function requireClubCapability(organizationId: string, need: keyof ClubCapabilities, now = new Date()) {
  const access = await getClubRoleAccess(organizationId, now);
  if (access.state === "SIGN_IN") throw new RosterAccessError("SIGN_IN_REQUIRED", 401, "Sign in to open your club.");
  if (access.state === "NOT_FOUND") throw new RosterAccessError("NOT_FOUND", 404, "That club could not be found.");
  if (access.state === "OWN_SESSION_REQUIRED") {
    throw new RosterAccessError("OWN_SESSION_REQUIRED", 403, "Sign in with your own attendee account to change club information.");
  }
  if (!access.capabilities[need]) {
    throw new RosterAccessError("ROLE_NOT_ALLOWED", 403, "Your club role doesn't include this. Ask your club director.");
  }
  return access;
}
