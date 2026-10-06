import { effectivePermissions, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { findActiveMembership } from "@/modules/events/repository";
import { lodgingApiError } from "@/modules/lodging/api-errors";
import { getRoomingReports } from "@/modules/lodging/assignment-view";
import { withRequestContext } from "@/lib/request-context";
import { AccessDeniedError } from "@/modules/access/authorization";

/**
 * Rooming list, occupancy by night, unassigned and conflicts, key hand-off inputs and closeout exceptions, as JSON for
 * the workspace. Permission-scoped: MANAGE_REGISTRATION or VIEW_REPORTS. Accessibility flags only with VIEW_SENSITIVE_DATA.
 */
async function getHandler(_request: Request, context: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await context.params;
    const session = await getCurrentSession();
    let access;
    try {
      access = await requirePermission(session, eventId, "MANAGE_REGISTRATION", findActiveMembership);
    } catch (error) {
      if (!(error instanceof AccessDeniedError)) throw error;
      access = await requirePermission(session, eventId, "VIEW_REPORTS", findActiveMembership);
    }
    const canSeeSensitive = new Set(effectivePermissions(access.user, access.membership)).has("VIEW_SENSITIVE_DATA");
    return Response.json({ reports: await getRoomingReports(eventId, { canSeeSensitive }) }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    return lodgingApiError(error, "Loading the rooming reports");
  }
}

export const GET = withRequestContext(getHandler);
