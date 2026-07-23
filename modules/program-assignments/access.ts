import {
  AccessDeniedError,
  requireEventMembership,
  type MembershipLookup,
  type Session,
} from "@/modules/access/authorization";
import { rolePermissions, type EventPermission } from "@/modules/access/permissions";

export const programAssignmentPermissions = [
  "MANAGE_REGISTRATION",
  "VIEW_SENSITIVE_DATA",
] as const satisfies readonly EventPermission[];

export function canManageProgramAssignments(
  permissions: readonly EventPermission[],
) {
  return programAssignmentPermissions.every((permission) => (
    permissions.includes(permission)
  ));
}

export async function requireProgramAssignmentAccess(
  session: Session,
  eventId: string,
  lookup: MembershipLookup,
) {
  const access = await requireEventMembership(session, eventId, lookup);
  if (access.user.globalRole === "SYSTEM_ADMIN") return access;
  const membership = access.membership;
  const grants = new Set<EventPermission>([
    ...(membership ? rolePermissions[membership.role] : []),
    ...(membership?.permissions ?? []),
  ]);
  if (!programAssignmentPermissions.every((permission) => grants.has(permission))) {
    throw new AccessDeniedError(
      "Registration-management and sensitive-data access are required for program assignments.",
      403,
      "PERMISSION_DENIED",
    );
  }
  return access;
}
