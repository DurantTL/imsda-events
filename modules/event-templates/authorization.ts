import {
  AccessDeniedError,
  requireAuthenticatedUser,
  type Session,
} from "@/modules/access/authorization";

/**
 * Template draft, publish, archive, and apply are all system-admin-only for
 * now (#152) — the same gate `requireEventCreationPermission` already puts on
 * creating an event directly, since applying a template creates one. A
 * future slice can open drafting to a delegated role without changing
 * anything that calls this.
 */
export function requireEventTemplateManagementPermission(session: Session) {
  const user = requireAuthenticatedUser(session);
  if (user.globalRole !== "SYSTEM_ADMIN") {
    throw new AccessDeniedError(
      "Only a system administrator can manage event templates.",
      403,
      "PERMISSION_DENIED",
    );
  }
  return user;
}

export function requireEventTemplateApplyPermission(session: Session) {
  const user = requireAuthenticatedUser(session);
  if (user.globalRole !== "SYSTEM_ADMIN") {
    throw new AccessDeniedError(
      "Only a system administrator can create an event from a template.",
      403,
      "PERMISSION_DENIED",
    );
  }
  return user;
}
