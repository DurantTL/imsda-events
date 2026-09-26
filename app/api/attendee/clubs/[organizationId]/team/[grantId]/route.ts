import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { actorAttribution, requireRosterAccess } from "@/modules/club-rosters/access";
import { rosterApiError } from "@/modules/club-rosters/api-errors";
import { revokeClubTeamRole } from "@/modules/organizations/director-grants-repository";
import { withRequestContext } from "@/lib/request-context";

/** A director or deputy removes a Registrar or Reporter (#375). Directors and deputies are removed by staff. */
async function deleteHandler(request: Request, context: { params: Promise<{ organizationId: string; grantId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, grantId } = await context.params;
    const access = await requireRosterAccess(organizationId, new Date(), "manageTeam");
    return Response.json({ team: await revokeClubTeamRole(organizationId, grantId, actorAttribution(access.actor)) });
  } catch (error) {
    return rosterApiError(error, "Removing someone from the club team");
  }
}

export const DELETE = withRequestContext(deleteHandler);
