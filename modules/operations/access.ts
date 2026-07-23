import type { EventPermission } from "@/modules/access/permissions";

export type OperationalHealthAccess = {
  finance: boolean;
  communications: boolean;
  imports: boolean;
  capacity: boolean;
};

export const operationalHealthEntryPermissions = [
  "MANAGE_FINANCE",
  "MANAGE_COMMUNICATIONS",
  "MANAGE_IMPORTS",
  "CONFIGURE_EVENT",
  "MANAGE_REGISTRATION",
  "MANAGE_FORMS",
] as const satisfies readonly EventPermission[];

export function operationalHealthAccessFor(
  permissions: readonly EventPermission[],
): OperationalHealthAccess {
  const granted = new Set(permissions);
  return {
    finance: granted.has("MANAGE_FINANCE"),
    communications: granted.has("MANAGE_COMMUNICATIONS"),
    imports: granted.has("MANAGE_IMPORTS"),
    capacity: (
      granted.has("CONFIGURE_EVENT")
      || granted.has("MANAGE_REGISTRATION")
      || granted.has("MANAGE_FORMS")
    ),
  };
}

export function canAccessOperationalHealth(
  permissions: readonly EventPermission[],
) {
  return operationalHealthEntryPermissions.some((permission) => (
    permissions.includes(permission)
  ));
}
