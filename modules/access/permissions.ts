export const eventPermissions = [
  "VIEW_EVENT",
  "CONFIGURE_EVENT",
  "MANAGE_REGISTRATION",
  "MANAGE_FINANCE",
  "MANAGE_COMMUNICATIONS",
  "MANAGE_CHECK_IN",
  "VIEW_REPORTS",
  "MANAGE_STAFF",
  "VIEW_SENSITIVE_DATA",
  "MANAGE_IMPORTS",
  "MANAGE_FORMS",
  /**
   * Allergies (as entered), emergency contacts and the medical-need flag for
   * club event attendees (#658, ADR 0005 Addendum C). Granted one membership at
   * a time by a system administrator and held by no role, EVENT_ADMIN included.
   * System administrators have it through `effectivePermissions`.
   */
  "VIEW_HEALTH_INFORMATION",
  /**
   * Finalizing a deferred-organization invoice (#167, ADR 0008): assigns its number and commits the
   * conference to the amount. Granted one membership at a time by a system administrator and held
   * by no role, EVENT_ADMIN and FINANCE_MANAGER (MANAGE_FINANCE) included. System administrators
   * have it through `effectivePermissions`. It is a grant on a staff assignment, like the health
   * permission, so a person who finalizes for several events holds it on each.
   */
  "FINALIZE_INVOICES",
] as const;

export type EventPermission = (typeof eventPermissions)[number];

export const eventRoles = [
  "EVENT_ADMIN",
  "REGISTRATION_MANAGER",
  "FINANCE_MANAGER",
  "COMMUNICATIONS_MANAGER",
  "CHECK_IN_STAFF",
  "READ_ONLY_STAFF",
] as const;

export type EventRole = (typeof eventRoles)[number];

export const rolePermissions: Record<EventRole, readonly EventPermission[]> = {
  // Everything except the permissions no role carries: health information (#658) and finalizing invoices (#167).
  EVENT_ADMIN: eventPermissions.filter((permission) => permission !== "VIEW_HEALTH_INFORMATION" && permission !== "FINALIZE_INVOICES"),
  REGISTRATION_MANAGER: ["VIEW_EVENT", "MANAGE_REGISTRATION", "MANAGE_FORMS", "VIEW_REPORTS", "VIEW_SENSITIVE_DATA"],
  FINANCE_MANAGER: ["VIEW_EVENT", "MANAGE_FINANCE", "VIEW_REPORTS", "VIEW_SENSITIVE_DATA"],
  COMMUNICATIONS_MANAGER: ["VIEW_EVENT", "MANAGE_COMMUNICATIONS"],
  CHECK_IN_STAFF: ["VIEW_EVENT", "MANAGE_CHECK_IN", "VIEW_SENSITIVE_DATA"],
  READ_ONLY_STAFF: ["VIEW_EVENT"],
};
