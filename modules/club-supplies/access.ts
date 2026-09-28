import "server-only";

import { getPrisma } from "@/lib/prisma";
import { actorAttribution, requireRosterAccess, RosterAccessError } from "@/modules/club-rosters/access";
import type { ClubSupplyStockActor } from "@/modules/club-supplies/repository";
import { currentAreaCoordinator } from "@/modules/organizations/area-coordinators";
import { currentStaffActingContext } from "@/modules/organizations/staff-act-as";

/**
 * Who may open and change a club's supply stock (#531).
 *
 * Editing goes through the roster's own gate, `requireRosterAccess` (ADR 0005
 * Addendum A), with the `manageTeam` capability: a director or deputy, or a
 * staff "act as" director (#442). The gate stays MFA-gated exactly like the
 * roster. A registrar, who has the roster but not `manageTeam`, gets the
 * same gate read-only.
 *
 * An Area Coordinator gets read-only access through their own mechanism, as
 * in `modules/honors/member-honor-access.ts`: tried only when the viewer has
 * no club role here at all, never to bypass a club role's own MFA or role
 * denial. The organization must be an active club, or the answer is 404.
 */
export type ClubSupplyAccess =
  | { mode: "EDIT"; actor: ClubSupplyStockActor }
  | { mode: "READ"; viewer: ClubSupplyStockActor };

const FALLBACK_CODES = new Set<RosterAccessError["code"]>(["NOT_FOUND", "SIGN_IN_REQUIRED"]);

async function isActiveClub(organizationId: string) {
  const organization = await getPrisma().organization.findUnique({
    where: { id: organizationId },
    select: { type: true, isActive: true },
  });
  return Boolean(organization && organization.type === "CLUB" && organization.isActive);
}

/** The Area Coordinator viewing right now (their own account, or a staff act-as), or null. */
async function areaCoordinatorViewer(): Promise<ClubSupplyStockActor | null> {
  const account = await currentAreaCoordinator();
  if (account) return { accountId: account.id };
  const acting = await currentStaffActingContext();
  return acting?.role === "AREA_COORDINATOR" ? { userId: acting.userId, actAsId: acting.actAsId } : null;
}

/** For routes only a club's director or deputy may reach (recording stock). */
export async function requireClubSupplyEditAccess(organizationId: string, now = new Date()): Promise<ClubSupplyStockActor> {
  const access = await requireRosterAccess(organizationId, now, "manageTeam");
  return actorAttribution(access.actor);
}

/** For routes that a club role (edit or read-only) and an Area Coordinator (read-only) may reach. */
export async function requireClubSupplyAccess(organizationId: string, now = new Date()): Promise<ClubSupplyAccess> {
  try {
    return { mode: "EDIT", actor: await requireClubSupplyEditAccess(organizationId, now) };
  } catch (error) {
    if (!(error instanceof RosterAccessError)) throw error;
    if (error.code === "ROLE_NOT_ALLOWED") {
      // Has the roster (a registrar), just not `manageTeam`: read-only. A role
      // without the roster at all is refused again here.
      const access = await requireRosterAccess(organizationId, now);
      return { mode: "READ", viewer: actorAttribution(access.actor) };
    }
    if (!FALLBACK_CODES.has(error.code)) throw error;
    const viewer = await areaCoordinatorViewer();
    if (!viewer) throw error;
    if (!(await isActiveClub(organizationId))) {
      throw new RosterAccessError("NOT_FOUND", 404, "That club could not be found.");
    }
    return { mode: "READ", viewer };
  }
}
