import "server-only";

import { actorAttribution, requireClubCapability } from "@/modules/club-rosters/access";
import type { MemberHonorActor } from "@/modules/honors/member-honor-repository";
import { currentAreaCoordinatorViewerActive } from "@/modules/organizations/area-coordinators";

/**
 * Who may open and change a club's Honors (#486): the same club roles that
 * can edit the roster (`clubCapabilities(...).roster`, reused as-is —
 * director, deputy, and registrar) may record and edit honors. An Area
 * Coordinator gets read-only access instead, from their own separate
 * mechanism (`currentAreaCoordinatorViewerActive`), never the roster
 * capability check.
 */
export type HonorsAccess =
  | { mode: "EDIT"; actor: MemberHonorActor }
  | { mode: "READ" };

/** For API routes that both a club role and an Area Coordinator may reach. */
export async function requireHonorsAccess(organizationId: string, now = new Date()): Promise<HonorsAccess> {
  if (await currentAreaCoordinatorViewerActive()) return { mode: "READ" };
  const access = await requireClubCapability(organizationId, "roster", now);
  return { mode: "EDIT", actor: actorAttribution(access.actor) };
}

/** For routes only a club's own roster-capable role may reach (recording an entry). */
export async function requireHonorsEditAccess(organizationId: string, now = new Date()) {
  const access = await requireClubCapability(organizationId, "roster", now);
  return actorAttribution(access.actor);
}
