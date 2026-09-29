import "server-only";

import { getPrisma } from "@/lib/prisma";
import { actorAttribution, requireRosterAccess, RosterAccessError } from "@/modules/club-rosters/access";
import type { MemberHonorActor } from "@/modules/honors/member-honor-repository";
import { currentAreaCoordinator } from "@/modules/organizations/area-coordinators";
import { currentStaffActingContext } from "@/modules/organizations/staff-act-as";

/**
 * Who may open and change a club's Honors (#486).
 *
 * A club role goes through exactly the roster's own gate,
 * `requireRosterAccess` (ADR 0005 Addendum A): director, deputy, or
 * registrar, their own attendee session, and the roster's authenticator or
 * passkey set up (`MFA_SETUP_REQUIRED`) and used within the unlock window
 * (`MFA_UNLOCK_REQUIRED`). A staff "act as" director (#442) resolves the same
 * way the roster does. Honors never open on a weaker check than the roster.
 *
 * An Area Coordinator gets read-only access instead, from their own separate
 * mechanism (the same viewer rule as `currentAreaCoordinatorViewerActive`,
 * resolved here to who is viewing so a CSV export can be attributed). The club role is always
 * tried first; the Area Coordinator fallback applies only when the viewer
 * has no club role here at all (`NOT_FOUND`, or `SIGN_IN_REQUIRED` for a
 * staff "act as" Area Coordinator, which has no attendee session), never to
 * bypass a club role's own MFA or role denial. The organization must be an
 * active club, or the answer is 404.
 */
export type HonorsAccess =
  | { mode: "EDIT"; actor: MemberHonorActor }
  | { mode: "READ"; viewer: MemberHonorActor };

const FALLBACK_CODES = new Set<RosterAccessError["code"]>(["NOT_FOUND", "SIGN_IN_REQUIRED"]);

async function isActiveClub(organizationId: string) {
  const organization = await getPrisma().organization.findUnique({
    where: { id: organizationId },
    select: { type: true, isActive: true },
  });
  return Boolean(organization && organization.type === "CLUB" && organization.isActive);
}

/** The Area Coordinator viewing right now (their own account, or a staff act-as), or null. */
async function areaCoordinatorViewer(): Promise<MemberHonorActor | null> {
  const account = await currentAreaCoordinator();
  if (account) return { accountId: account.id };
  const acting = await currentStaffActingContext();
  return acting?.role === "AREA_COORDINATOR" ? { userId: acting.userId, actAsId: acting.actAsId } : null;
}

/** For API routes that both a club role and an Area Coordinator may reach. */
export async function requireHonorsAccess(organizationId: string, now = new Date()): Promise<HonorsAccess> {
  try {
    return { mode: "EDIT", actor: await requireHonorsEditAccess(organizationId, now) };
  } catch (error) {
    if (!(error instanceof RosterAccessError) || !FALLBACK_CODES.has(error.code)) throw error;
    const viewer = await areaCoordinatorViewer();
    if (!viewer) throw error;
    if (!(await isActiveClub(organizationId))) {
      throw new RosterAccessError("NOT_FOUND", 404, "That club could not be found.");
    }
    return { mode: "READ", viewer };
  }
}

/** For routes only a club's own roster-capable role may reach (recording an entry). */
export async function requireHonorsEditAccess(organizationId: string, now = new Date()): Promise<MemberHonorActor> {
  const access = await requireRosterAccess(organizationId, now);
  return actorAttribution(access.actor);
}

/**
 * For voiding an honor entry (#591): the club's director or deputy (or staff
 * acting as the director), through the roster's own gate and MFA. The
 * `manageTeam` capability is exactly the leader roles (director and deputy):
 * a registrar can record honors but not void them, and an Area Coordinator's
 * read-only view never reaches this (`requireRosterAccess` has no fallback).
 */
export async function requireHonorsVoidAccess(organizationId: string, now = new Date()): Promise<MemberHonorActor> {
  const access = await requireRosterAccess(organizationId, now, "manageTeam");
  return actorAttribution(access.actor);
}
