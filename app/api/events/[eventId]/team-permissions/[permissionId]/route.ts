import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubTeamApiError } from "@/modules/club-teams/api-errors";
import { permissionDecisionSchema } from "@/modules/club-teams/permission-domain";
import { decideTeamPermission } from "@/modules/club-teams/permission-repository";
import { findActiveMembership } from "@/modules/events/repository";
import { withRequestContext } from "@/lib/request-context";

/**
 * Grants or declines a team member's permission to be on a team at 18 or older (#809). Staff who manage the event's
 * registrations (MANAGE_REGISTRATION); the Area Coordinator decides from their own page.
 */
async function putHandler(request: Request, context: { params: Promise<{ eventId: string; permissionId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, permissionId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_REGISTRATION", findActiveMembership);
    const { decision } = permissionDecisionSchema.parse(await request.json());
    const row = await decideTeamPermission({ permissionId, decision, actor: { userId: access.user.id }, scope: { eventId } });
    return Response.json({ permission: row }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return clubTeamApiError(error, "Deciding the permission");
  }
}

export const PUT = withRequestContext(putHandler);
