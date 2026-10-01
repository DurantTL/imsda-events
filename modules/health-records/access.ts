import "server-only";

import { getPrisma } from "@/lib/prisma";
import { AccessDeniedError } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { requireRosterAccess } from "@/modules/club-rosters/access";
import { currentAreaCoordinator } from "@/modules/organizations/area-coordinators";
import { isClubFormsRole } from "@/modules/club-forms/domain";
import { HEALTH_NOT_FOUND_MESSAGE, HealthRecordError } from "@/modules/health-records/errors";
import { requireHealthRecordsEnabled } from "@/modules/health-records/flag";
import type { HealthViewer } from "@/modules/health-records/domain";

/**
 * Turns the current session into a `HealthViewer` (#611). This is the only
 * place a session becomes health-record authority, and the flag is checked
 * first so a switched-off site never reaches a database read.
 *
 * - A club's director or deputy, past the roster's second step: their own
 *   club only, all year. A registrar, reporter or another club's director is
 *   refused by the roster gate or by the role check below.
 * - An Area Coordinator with a verified second sign-in step: view only, and
 *   only for members registered for an event inside its window (checked where
 *   the member is loaded, with the event id).
 * - System administrators: view only. Staff holding VIEW_HEALTH_INFORMATION on
 *   an event membership (the permission #658 introduced; a system administrator
 *   grants it): view only, for that event's attendees. Being an Event Admin or
 *   holding VIEW_SENSITIVE_DATA is not enough.
 */

/**
 * For the club portal and its API routes: the club's own director or deputy.
 * A system administrator "acting as" the director is a system administrator:
 * view-only staff, never an editor of health records.
 */
export async function requireHealthViewerForClub(organizationId: string, now = new Date()): Promise<HealthViewer> {
  requireHealthRecordsEnabled();
  const access = await requireRosterAccess(organizationId, now);
  if (access.actor.kind === "STAFF_ACTING") {
    return { kind: "SYSTEM_ADMIN", userId: access.actor.userId };
  }
  if (!isClubFormsRole(access.club.role)) {
    throw new HealthRecordError("FORBIDDEN", "Health records are for the club's director and deputy.");
  }
  return { kind: "CLUB_LEADER", organizationId: access.club.organizationId, accountId: access.actor.accountId };
}

/**
 * For staff routes and pages: a system administrator, or a user whose ACTIVE
 * event membership carries VIEW_HEALTH_INFORMATION (view only, for those events).
 */
export async function requireStaffHealthViewer(): Promise<HealthViewer> {
  requireHealthRecordsEnabled();
  const { user } = await getCurrentSession();
  if (!user) throw new AccessDeniedError("Authentication is required.", 401, "AUTHENTICATION_REQUIRED");
  if (user.globalRole === "SYSTEM_ADMIN") return { kind: "SYSTEM_ADMIN", userId: user.id };
  const memberships = await getPrisma().eventMembership.findMany({
    where: { userId: user.id, status: "ACTIVE", permissions: { has: "VIEW_HEALTH_INFORMATION" } },
    select: { eventId: true, permissions: true },
  });
  // Re-check the grant itself, so a stale or odd row never widens access.
  const eventIds = memberships
    .filter((membership) => membership.permissions.includes("VIEW_HEALTH_INFORMATION"))
    .map((membership) => membership.eventId);
  if (eventIds.length === 0) throw new HealthRecordError("FORBIDDEN", "Health records need the health information permission.");
  return { kind: "HEALTH_ROLE", userId: user.id, eventIds };
}

/**
 * For the Area Coordinator's event-scoped health view. `currentAreaCoordinator`
 * itself requires the verified second sign-in step (the same gate the other
 * coordinator pages use), so an unverified coordinator is simply not one here.
 * Anyone else, including a club director or staff, is not found.
 */
export async function requireAreaCoordinatorHealthViewer(): Promise<HealthViewer> {
  requireHealthRecordsEnabled();
  const account = await currentAreaCoordinator();
  if (!account) throw new HealthRecordError("NOT_FOUND", HEALTH_NOT_FOUND_MESSAGE);
  return { kind: "AREA_COORDINATOR", accountId: account.id };
}
