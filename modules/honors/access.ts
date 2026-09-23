import "server-only";

import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import type { EventPermission } from "@/modules/access/permissions";
import { findActiveMembership } from "@/modules/events/repository";

/** Honors Weekend setup is event configuration: CONFIGURE_EVENT on that site. */
export async function requireHonorPermission(eventId: string, permission: EventPermission = "CONFIGURE_EVENT") {
  return requirePermission(await getCurrentSession(), eventId, permission, findActiveMembership);
}
