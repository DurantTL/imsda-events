import {
  AccessDeniedError,
  requireAuthenticatedUser,
  type Session,
} from "@/modules/access/authorization";

/**
 * Previewing and confirming an annual clone (#157) are system-admin-only, the
 * same gate `requireEventCreationPermission` puts on creating an event
 * directly: a clone creates one. Checked server-side on every route.
 */
export function requireEventClonePermission(session: Session) {
  const user = requireAuthenticatedUser(session);
  if (user.globalRole !== "SYSTEM_ADMIN") {
    throw new AccessDeniedError(
      "Only a system administrator can copy an event.",
      403,
      "PERMISSION_DENIED",
    );
  }
  return user;
}
