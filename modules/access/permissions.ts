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
  EVENT_ADMIN: eventPermissions,
  REGISTRATION_MANAGER: ["VIEW_EVENT", "MANAGE_REGISTRATION", "MANAGE_FORMS", "VIEW_REPORTS", "VIEW_SENSITIVE_DATA"],
  FINANCE_MANAGER: ["VIEW_EVENT", "MANAGE_FINANCE", "VIEW_REPORTS", "VIEW_SENSITIVE_DATA"],
  COMMUNICATIONS_MANAGER: ["VIEW_EVENT", "MANAGE_COMMUNICATIONS"],
  CHECK_IN_STAFF: ["VIEW_EVENT", "MANAGE_CHECK_IN", "VIEW_SENSITIVE_DATA"],
  READ_ONLY_STAFF: ["VIEW_EVENT"],
};
