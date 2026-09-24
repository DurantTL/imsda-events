import {
  requirePermission,
  type MembershipLookup,
  type Session,
} from "@/modules/access/authorization";
import type { EventPermission } from "@/modules/access/permissions";

/**
 * Club event assignments (#410): editing campsite/duty/activity uses the
 * same registration-management permission every other club roster screen
 * uses. Sending the assignment email is gated separately, on
 * `MANAGE_COMMUNICATIONS`, matching every other staff-reviewed batch send.
 * The server-side checks delegate to the shared `requirePermission` so role
 * grants and the SYSTEM_ADMIN case are decided in exactly one place.
 */
export function canManageClubAssignments(permissions: readonly EventPermission[]) {
  return permissions.includes("MANAGE_REGISTRATION");
}

export function canSendClubAssignmentMessages(permissions: readonly EventPermission[]) {
  return permissions.includes("MANAGE_COMMUNICATIONS");
}

export function requireClubAssignmentAccess(
  session: Session,
  eventId: string,
  lookup: MembershipLookup,
) {
  return requirePermission(session, eventId, "MANAGE_REGISTRATION", lookup);
}

export function requireClubAssignmentMessageAccess(
  session: Session,
  eventId: string,
  lookup: MembershipLookup,
) {
  return requirePermission(session, eventId, "MANAGE_COMMUNICATIONS", lookup);
}
