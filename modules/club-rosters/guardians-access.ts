import "server-only";

import { getPrisma } from "@/lib/prisma";
import { getCurrentSession } from "@/modules/access/current-session";
import { rolePermissions } from "@/modules/access/permissions";
import { resolveAreaCoordinatorViewer } from "@/modules/club-forms/access";
import type { requireRosterAccess } from "@/modules/club-rosters/access";
import { RosterAccessError } from "@/modules/club-rosters/access";
import { listGuardiansByMember } from "@/modules/club-rosters/guardians-repository";
import { staffHoldsSensitiveData, type GuardianRecord, type GuardianViewer } from "@/modules/club-rosters/guardians-domain";
import { hasEventEnded } from "@/modules/events/lifecycle";

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
 * Conference staff with the sensitive-data permission, or null. A system
 * administrator is always allowed. Anyone else must hold the permission on the
 * given event's membership, and that event must not have ended (the same
 * precedent as `staffClubFormsAccess`); with no event named they get nothing.
 */
export async function resolveStaffGuardianViewer(eventId?: string, now = new Date()): Promise<Extract<GuardianViewer, { kind: "STAFF" }> | null> {
  const { user } = await getCurrentSession();
  if (!user) return null;
  const viewer = { kind: "STAFF" as const, userId: user.id };
  if (user.globalRole === "SYSTEM_ADMIN") return viewer;
  if (!eventId) return null;
  const prisma = getPrisma();
  const [memberships, event] = await Promise.all([
    prisma.eventMembership.findMany({
      where: { userId: user.id, status: "ACTIVE", eventId },
      select: { eventId: true, status: true, role: true, permissions: true },
    }),
    prisma.event.findUnique({ where: { id: eventId }, select: { timezone: true, endsAt: true } }),
  ]);
  if (!event || hasEventEnded(event, now)) return null;
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
  return allowed ? viewer : null;
}
