import {
  AccessDeniedError,
  requireAuthenticatedUser,
  type Session,
} from "@/modules/access/authorization";

export function requireEventCreationPermission(session: Session) {
  const user = requireAuthenticatedUser(session);
  if (user.globalRole !== "SYSTEM_ADMIN") {
    throw new AccessDeniedError(
      "Only a system administrator can create a new event.",
      403,
      "PERMISSION_DENIED",
    );
  }
  return user;
}
