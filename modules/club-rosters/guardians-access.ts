import "server-only";

import { getPrisma } from "@/lib/prisma";
import { AccessDeniedError } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rolePermissions } from "@/modules/access/permissions";
import { resolveAreaCoordinatorViewer } from "@/modules/club-forms/access";
import type { requireRosterAccess } from "@/modules/club-rosters/access";
import { RosterAccessError } from "@/modules/club-rosters/access";
import { listGuardiansByMember } from "@/modules/club-rosters/guardians-repository";
import { staffHoldsSensitiveData, type GuardianRecord, type GuardianViewer } from "@/modules/club-rosters/guardians-domain";

/**
 * Turns a session into a `GuardianViewer` (#510). Three ways in and nothing
 * else: the club's own director or deputy (read and edit), any Area
 * Coordinator (read, every club), and conference staff holding
 * VIEW_SENSITIVE_DATA (read). A registrar, reporter, ordinary attendee or
 * another club's director never gets a viewer.
 */

type OpenRosterAccess = Awaited<ReturnType<typeof requireRosterAccess>>;

/** The viewer for an already-open club: its director or deputy only (a registrar gets null). */
export function clubLeaderGuardianViewerFromAccess(access: OpenRosterAccess): Extract<GuardianViewer, { kind: "CLUB_LEADER" }> | null {
  if (!access.capabilities.guardians) return null;
  return {
    kind: "CLUB_LEADER",
    organizationId: access.club.organizationId,
    actor: access.actor.kind === "ATTENDEE"
      ? { kind: "ATTENDEE", accountId: access.actor.accountId }
      : { kind: "STAFF_ACTING", userId: access.actor.userId, actAsId: access.actor.actAsId },
  };
}

/** For roster routes that write guardians: the club leader viewer, or a 403 for any other role. */
export function requireGuardianEditor(access: OpenRosterAccess) {
  const viewer = clubLeaderGuardianViewerFromAccess(access);
  if (!viewer) {
    throw new RosterAccessError("ROLE_NOT_ALLOWED", 403, "Guardian contacts are for your club's director and deputy.");
  }
  return viewer;
}

/**
 * The club's guardians for the roster response, or undefined for a role that
 * may not see them (so the response never carries the key at all).
 */
export async function rosterGuardiansForAccess(
  access: OpenRosterAccess,
  organizationId: string,
  clubYear: string,
): Promise<Record<string, GuardianRecord[]> | undefined> {
  const viewer = clubLeaderGuardianViewerFromAccess(access);
  return viewer ? listGuardiansByMember(viewer, organizationId, clubYear) : undefined;
}

/** An Area Coordinator (their own account, or a system administrator acting as one), or null. */
export async function resolveAreaGuardianViewer(): Promise<Extract<GuardianViewer, { kind: "AREA_COORDINATOR" }> | null> {
  const viewer = await resolveAreaCoordinatorViewer();
  if (!viewer) return null;
  return {
    kind: "AREA_COORDINATOR",
    actor: viewer.actor.kind === "ATTENDEE"
      ? { kind: "ATTENDEE", accountId: viewer.actor.accountId }
      : { kind: "STAFF_ACTING", userId: viewer.actor.userId, actAsId: viewer.actor.actAsId },
  };
}

/**
 * Conference staff with the sensitive-data permission (or a system
 * administrator), or null. `eventId` narrows it to that event's membership.
 */
export async function resolveStaffGuardianViewer(eventId?: string): Promise<Extract<GuardianViewer, { kind: "STAFF" }> | null> {
  const { user } = await getCurrentSession();
  if (!user) return null;
  const memberships = user.globalRole === "SYSTEM_ADMIN"
    ? []
    : await getPrisma().eventMembership.findMany({
      where: { userId: user.id, status: "ACTIVE", ...(eventId ? { eventId } : {}) },
      select: { eventId: true, status: true, role: true, permissions: true },
    });
  const allowed = staffHoldsSensitiveData(
    user,
    memberships.map((membership) => ({
      eventId: membership.eventId,
      status: membership.status,
      permissions: membership.permissions,
      roleHasSensitiveData: (rolePermissions[membership.role] as readonly string[]).includes("VIEW_SENSITIVE_DATA"),
    })),
    eventId,
  );
  return allowed ? { kind: "STAFF", userId: user.id } : null;
}

/** For staff API routes: the staff viewer, or a 401 / 403. */
export async function requireStaffGuardianViewer(eventId?: string) {
  const { user } = await getCurrentSession();
  if (!user) throw new AccessDeniedError("Authentication is required.", 401, "AUTHENTICATION_REQUIRED");
  const viewer = await resolveStaffGuardianViewer(eventId);
  if (!viewer) throw new AccessDeniedError("Guardian contacts need the sensitive data permission.", 403, "PERMISSION_DENIED");
  return viewer;
}

/** Any signed-in viewer allowed on a club's coordinator or staff page: coordinator first, then staff. */
export async function resolveCoordinatorOrStaffGuardianViewer(eventId?: string): Promise<GuardianViewer | null> {
  return (await resolveAreaGuardianViewer()) ?? (await resolveStaffGuardianViewer(eventId));
}
