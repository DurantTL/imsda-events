import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubTeamApiError } from "@/modules/club-teams/api-errors";
import { saveTeamResult } from "@/modules/club-teams/results-repository";
import { findActiveMembership } from "@/modules/events/repository";
import { withRequestContext } from "@/lib/request-context";

/**
 * Enters, changes or clears one level of a team's result (#809). Staff who manage the event's registrations
 * (MANAGE_REGISTRATION: registration managers and event administrators). `registrationId` is the team's club registration id.
 */
async function putHandler(request: Request, context: { params: Promise<{ eventId: string; registrationId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, registrationId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_REGISTRATION", findActiveMembership);
    const saved = await saveTeamResult(eventId, registrationId, await request.json(), access.user.id);
    return Response.json(saved, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return clubTeamApiError(error, "Saving the team result");
  }
}

export const PUT = withRequestContext(putHandler);
