import "server-only";

import { getPrisma } from "@/lib/prisma";
import { getCurrentSession } from "@/modules/access/current-session";
import { isClubFormsRole } from "@/modules/club-forms/domain";
import type { requireRosterAccess } from "@/modules/club-rosters/access";
import type { HealthViewer } from "@/modules/coordinator-health/domain";
import { currentAreaCoordinator } from "@/modules/organizations/area-coordinators";

/**
 * Turns a session into a `HealthViewer` (#658). Four ways in, and nothing else:
 * system administrators and active Area Coordinators (automatic), staff holding
 * the separately granted VIEW_HEALTH_INFORMATION permission, and a club's own
 * director or deputy. Event Admins and VIEW_SENSITIVE_DATA holders get nothing
 * unless they also hold the health permission. Every page and route calls the
 * repository with one of these viewers, and the repository checks again.
 */

/** Staff: a system administrator, or a user whose ACTIVE membership carries VIEW_HEALTH_INFORMATION. */
export async function resolveStaffHealthViewer(): Promise<Extract<HealthViewer, { kind: "SYSTEM_ADMIN" | "HEALTH_ROLE" }> | null> {
  const { user } = await getCurrentSession();
  if (!user) return null;
  if (user.globalRole === "SYSTEM_ADMIN") return { kind: "SYSTEM_ADMIN", userId: user.id };
  const memberships = await getPrisma().eventMembership.findMany({
    where: { userId: user.id, status: "ACTIVE", permissions: { has: "VIEW_HEALTH_INFORMATION" } },
    select: { eventId: true, permissions: true },
  });
  // Re-check the grant itself, so a stale or odd row never widens access.
  const eventIds = memberships.filter((membership) => membership.permissions.includes("VIEW_HEALTH_INFORMATION")).map((membership) => membership.eventId);
  return eventIds.length > 0 ? { kind: "HEALTH_ROLE", userId: user.id, eventIds } : null;
}

/** The signed-in Area Coordinator who passed the second step (checked inside `currentAreaCoordinator`), or null. */
export async function resolveAreaHealthViewer(): Promise<Extract<HealthViewer, { kind: "AREA_COORDINATOR" }> | null> {
  const account = await currentAreaCoordinator();
  return account ? { kind: "AREA_COORDINATOR", accountId: account.id } : null;
}

type OpenRosterAccess = Awaited<ReturnType<typeof requireRosterAccess>>;

/** The viewer for an already-open club (director or deputy only; a registrar or reporter gets null). */
export function clubLeaderHealthViewerFromAccess(access: OpenRosterAccess): Extract<HealthViewer, { kind: "CLUB_LEADER" }> | null {
  if (!isClubFormsRole(access.club.role)) return null;
  return {
    kind: "CLUB_LEADER",
    organizationId: access.club.organizationId,
    actor: access.actor.kind === "ATTENDEE"
      ? { kind: "ATTENDEE", accountId: access.actor.accountId }
      : { kind: "STAFF_ACTING", userId: access.actor.userId, actAsId: access.actor.actAsId },
  };
}
