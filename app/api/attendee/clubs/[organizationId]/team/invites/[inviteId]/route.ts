import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { cancelClubTeamInvite, listPendingClubTeamInvites } from "@/modules/club-imports/invites";
import { requireRosterAccess } from "@/modules/club-rosters/access";
import { rosterApiError } from "@/modules/club-rosters/api-errors";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ organizationId: string; inviteId: string }> };

/** A director or deputy cancels a pending club team invite (#425). */
async function deleteHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, inviteId } = await context.params;
    const access = await requireRosterAccess(organizationId, new Date(), "manageTeam");
    await cancelClubTeamInvite(organizationId, inviteId, access.accountId);
    return Response.json({ invites: await listPendingClubTeamInvites(organizationId) });
  } catch (error) {
    return rosterApiError(error, "Cancelling a club team invite");
  }
}

export const DELETE = withRequestContext(deleteHandler);
