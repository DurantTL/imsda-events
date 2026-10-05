import { effectivePermissions, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import type { EventPermission } from "@/modules/access/permissions";
import { findActiveMembership } from "@/modules/events/repository";

/**
 * The server-side check every staff lodging-request route and page makes (#199): the permission for the event in
 * the URL, plus whether this person may also read the yes/no accessibility flags (VIEW_SENSITIVE_DATA).
 */
export async function requireLodgingStaff(eventId: string, permission: EventPermission) {
  const access = await requirePermission(await getCurrentSession(), eventId, permission, findActiveMembership);
  return {
    userId: access.user.id,
    canSeeSensitive: new Set(effectivePermissions(access.user, access.membership)).has("VIEW_SENSITIVE_DATA"),
  };
}
