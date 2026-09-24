import {
  AccessDeniedError,
  type MembershipRecord,
  requireEventMembership,
  type MembershipLookup,
  type Session,
} from "@/modules/access/authorization";
import { rolePermissions, type EventPermission } from "@/modules/access/permissions";

/**
 * Club event assignments (#410): editing campsite/duty/activity uses the
 * same registration-management permission every other club roster screen
 * uses. Sending the assignment email is gated separately, on
 * `MANAGE_COMMUNICATIONS`, matching every other staff-reviewed batch send.
 */
export function canManageClubAssignments(permissions: readonly EventPermission[]) {
  return permissions.includes("MANAGE_REGISTRATION");
}

export function canSendClubAssignmentMessages(permissions: readonly EventPermission[]) {
  return permissions.includes("MANAGE_COMMUNICATIONS");
}

// Called only after the SYSTEM_ADMIN case has already returned, so this
// reads the membership's own role and per-event grants.
function grantedPermissions(access: { membership: MembershipRecord | null }) {
  return new Set<EventPermission>([
    ...(access.membership ? rolePermissions[access.membership.role] : []),
    ...(access.membership?.permissions ?? []),
  ]);
}

export async function requireClubAssignmentAccess(
  session: Session,
  eventId: string,
  lookup: MembershipLookup,
) {
  const access = await requireEventMembership(session, eventId, lookup);
  if (access.user.globalRole === "SYSTEM_ADMIN") return access;
  if (!canManageClubAssignments([...grantedPermissions(access)])) {
    throw new AccessDeniedError(
      "Registration-management access is required for club assignments.",
      403,
      "PERMISSION_DENIED",
    );
  }
  return access;
}

export async function requireClubAssignmentMessageAccess(
  session: Session,
  eventId: string,
  lookup: MembershipLookup,
) {
  const access = await requireEventMembership(session, eventId, lookup);
  if (access.user.globalRole === "SYSTEM_ADMIN") return access;
  if (!canSendClubAssignmentMessages([...grantedPermissions(access)])) {
    throw new AccessDeniedError(
      "Communications access is required to send the club assignment email.",
      403,
      "PERMISSION_DENIED",
    );
  }
  return access;
}
