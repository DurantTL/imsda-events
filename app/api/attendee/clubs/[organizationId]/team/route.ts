import { after } from "next/server";
import { logError } from "@/lib/logger";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { listPendingClubTeamInvites } from "@/modules/club-imports/invites";
import { actorAttribution, requireRosterAccess } from "@/modules/club-rosters/access";
import { rosterApiError } from "@/modules/club-rosters/api-errors";
import { processAccountEmailQueue } from "@/modules/communications/email-delivery";
import { grantClubTeamRole, listClubTeam } from "@/modules/organizations/director-grants-repository";
import { createClubTeamGrantInputSchema } from "@/modules/organizations/director-grants-schemas";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ organizationId: string }> };

/** The club's current team and its pending invites, for a director or deputy (#375, #425). */
async function getHandler(_request: Request, context: RouteContext) {
  try {
    const { organizationId } = await context.params;
    await requireRosterAccess(organizationId, new Date(), "manageTeam");
    const [team, invites] = await Promise.all([
      listClubTeam(organizationId),
      listPendingClubTeamInvites(organizationId),
    ]);
    return Response.json({ team, invites }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return rosterApiError(error, "Loading the club team");
  }
}

/**
 * A director or deputy gives someone the Registrar or Reporter role, or —
 * with no verified account yet — invites them by email (#425).
 */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId } = await context.params;
    const access = await requireRosterAccess(organizationId, new Date(), "manageTeam");
    const input = createClubTeamGrantInputSchema.parse(await request.json());
    const { team, invited, messageId } = await grantClubTeamRole(organizationId, input, actorAttribution(access.actor));
    if (messageId) {
      after(async () => {
        try {
          await processAccountEmailQueue({ messageIds: [messageId], limit: 1 });
        } catch (error) {
          logError("A club team email was queued but not delivered after the response.", error, { messageId });
        }
      });
    }
    const invites = await listPendingClubTeamInvites(organizationId);
    return Response.json({ team, invites, invited }, { status: 201 });
  } catch (error) {
    return rosterApiError(error, "Adding someone to the club team");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
