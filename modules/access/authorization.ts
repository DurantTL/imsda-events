import type { EventPermission, EventRole } from "@/modules/access/permissions";
import { rolePermissions } from "@/modules/access/permissions";

export type AuthenticatedUser = {
  id: string;
  email: string;
  displayName: string;
  globalRole?: "SYSTEM_ADMIN" | null;
};

export type Session = { user: AuthenticatedUser | null };

export type MembershipRecord = {
  eventId: string;
  userId: string;
  role: EventRole;
  status: "ACTIVE" | "INACTIVE";
  permissions: readonly EventPermission[];
};

export type MembershipLookup = (
  userId: string,
  eventId: string,
) => Promise<MembershipRecord | null>;

export class AccessDeniedError extends Error {
  constructor(
    message: string,
    public readonly status: 401 | 403,
    public readonly code: "AUTHENTICATION_REQUIRED" | "EVENT_ACCESS_DENIED" | "PERMISSION_DENIED",
  ) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export function requireAuthenticatedUser(session: Session): AuthenticatedUser {
  if (!session.user) {
    throw new AccessDeniedError(
      "Authentication is required.",
      401,
      "AUTHENTICATION_REQUIRED",
    );
  }

  return session.user;
}

export async function requireEventMembership(
  session: Session,
  eventId: string,
  lookup: MembershipLookup,
): Promise<{ user: AuthenticatedUser; membership: MembershipRecord | null }> {
  const user = requireAuthenticatedUser(session);

  if (user.globalRole === "SYSTEM_ADMIN") {
    return { user, membership: null };
  }

  const membership = await lookup(user.id, eventId);
  if (!membership || membership.status !== "ACTIVE") {
    throw new AccessDeniedError(
      "This account is not assigned to the requested event.",
      403,
      "EVENT_ACCESS_DENIED",
    );
  }

  return { user, membership };
}

export async function requirePermission(
  session: Session,
  eventId: string,
  permission: EventPermission,
  lookup: MembershipLookup,
) {
  const access = await requireEventMembership(session, eventId, lookup);
  if (access.user.globalRole === "SYSTEM_ADMIN") return access;

  const membership = access.membership;
  const grants = new Set([
    ...(membership ? rolePermissions[membership.role] : []),
    ...(membership?.permissions ?? []),
  ]);

  if (!grants.has(permission)) {
    throw new AccessDeniedError(
      `The ${permission} permission is required for this event.`,
      403,
      "PERMISSION_DENIED",
    );
  }

  return access;
}
