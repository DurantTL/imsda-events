import "server-only";

import { getPrisma } from "@/lib/prisma";
import { AccessDeniedError, type AuthenticatedUser } from "@/modules/access/authorization";
import { hasEventEnded } from "@/modules/events/lifecycle";
import { getCurrentSession } from "@/modules/access/current-session";
import { requireRosterAccess, type ClubActor } from "@/modules/club-rosters/access";
import { isClubFormsRole, type ClubFormActor, type ClubFormsViewer } from "@/modules/club-forms/domain";
import { ClubFormError } from "@/modules/club-forms/errors";
import { currentAreaCoordinator } from "@/modules/organizations/area-coordinators";
import { currentStaffActingContext } from "@/modules/organizations/staff-act-as";

/**
 * Turns the current session into a `ClubFormsViewer` (#610). This is the only
 * place a session becomes club-forms authority; the repositories then check
 * the viewer again.
 */

function actorFromClubActor(actor: ClubActor): ClubFormActor {
  return actor.kind === "ATTENDEE"
    ? { kind: "ATTENDEE", accountId: actor.accountId }
    : { kind: "STAFF_ACTING", userId: actor.userId, actAsId: actor.actAsId };
}

type OpenRosterAccess = Awaited<ReturnType<typeof requireRosterAccess>>;

/** The viewer for an already-open club (the club portal's own gate has passed). */
export function clubLeaderViewerFromAccess(access: OpenRosterAccess): Extract<ClubFormsViewer, { kind: "CLUB_LEADER" }> {
  if (!isClubFormsRole(access.club.role)) {
    throw new ClubFormError("FORBIDDEN", "Club forms are for the club's director and deputy.");
  }
  return {
    kind: "CLUB_LEADER",
    organizationId: access.club.organizationId,
    actor: actorFromClubActor(access.actor),
  };
}

/**
 * For API routes: the club's director or deputy, signed in with their own
 * account and past the roster's second step (these files hold birth dates and
 * health answers), or a system administrator acting as that director. Another
 * club is "not found"; a registrar or reporter is refused.
 */
export async function requireClubLeaderViewer(organizationId: string, now = new Date()) {
  const access = await requireRosterAccess(organizationId, now);
  return clubLeaderViewerFromAccess(access);
}

/** An Area Coordinator (their own account, or a system administrator acting as one), or null. */
export async function resolveAreaCoordinatorViewer(): Promise<Extract<ClubFormsViewer, { kind: "AREA_COORDINATOR" }> | null> {
  const account = await currentAreaCoordinator();
  if (account) return { kind: "AREA_COORDINATOR", actor: { kind: "ATTENDEE", accountId: account.id } };
  const acting = await currentStaffActingContext();
  if (acting?.role === "AREA_COORDINATOR") {
    return { kind: "AREA_COORDINATOR", actor: { kind: "STAFF_ACTING", userId: acting.userId, actAsId: acting.actAsId } };
  }
  return null;
}

/**
 * Conference staff for club forms (Caleb, 2026-09-29): system administrators,
 * and Event Admins of an event that has not ended. Nobody else, whatever other
 * permissions they hold: not check-in, read-only, communications, registration
 * or finance roles, even with VIEW_SENSITIVE_DATA. Conference staff read the
 * sensitive answers; only a system administrator reads birth dates (the
 * viewer's `systemAdmin` flag decides that). The event model has no archived
 * state, so "current" is "has not ended" (`hasEventEnded`).
 */
export function staffClubFormsAccess(
  user: Pick<AuthenticatedUser, "globalRole">,
  memberships: ReadonlyArray<{
    role: string;
    event: { timezone: string; endsAt: Date };
  }>,
  now = new Date(),
): { isStaff: boolean; systemAdmin: boolean } {
  if (user.globalRole === "SYSTEM_ADMIN") return { isStaff: true, systemAdmin: true };
  const isStaff = memberships.some((membership) => membership.role === "EVENT_ADMIN" && !hasEventEnded(membership.event, now));
  return { isStaff, systemAdmin: false };
}

/** Conference staff, or null for anyone else (including a signed-out visitor). */
export async function resolveStaffViewer(now = new Date()): Promise<Extract<ClubFormsViewer, { kind: "STAFF" }> | null> {
  const { user } = await getCurrentSession();
  if (!user) return null;
  const memberships = user.globalRole === "SYSTEM_ADMIN"
    ? []
    : await getPrisma().eventMembership.findMany({
      where: { userId: user.id, status: "ACTIVE", role: "EVENT_ADMIN" },
      select: { role: true, event: { select: { timezone: true, endsAt: true } } },
    });
  const access = staffClubFormsAccess(user, memberships, now);
  return access.isStaff ? { kind: "STAFF", userId: user.id, systemAdmin: access.systemAdmin } : null;
}

/** For staff API routes: conference staff, or a 401 (signed out) / 403 (signed in, not staff). */
export async function requireStaffViewer() {
  const { user } = await getCurrentSession();
  if (!user) throw new AccessDeniedError("Authentication is required.", 401, "AUTHENTICATION_REQUIRED");
  const viewer = await resolveStaffViewer();
  if (!viewer) throw new AccessDeniedError("Conference staff access is required.", 403, "PERMISSION_DENIED");
  return viewer;
}

/** The signed-in system administrator, for the on/off page. Anyone else gets `null`. */
export async function resolveSystemAdmin() {
  const { user } = await getCurrentSession();
  return user && user.globalRole === "SYSTEM_ADMIN" ? user : null;
}
