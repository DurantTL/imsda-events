import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireRosterAccess } from "@/modules/club-rosters/access";
import { rosterApiError } from "@/modules/club-rosters/api-errors";
import { grantClubTeamRole, listClubTeam } from "@/modules/organizations/director-grants-repository";
import { createClubTeamGrantInputSchema } from "@/modules/organizations/director-grants-schemas";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ organizationId: string }> };

/** The club's current team, for its director or deputy (#375). */
async function getHandler(_request: Request, context: RouteContext) {
  try {
    const { organizationId } = await context.params;
    await requireRosterAccess(organizationId, new Date(), "manageTeam");
    return Response.json({ team: await listClubTeam(organizationId) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return rosterApiError(error, "Loading the club team");
  }
}

/** A director or deputy gives someone the Registrar or Reporter role. */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId } = await context.params;
    const access = await requireRosterAccess(organizationId, new Date(), "manageTeam");
    const input = createClubTeamGrantInputSchema.parse(await request.json());
    return Response.json({ team: await grantClubTeamRole(organizationId, input, access.accountId) }, { status: 201 });
  } catch (error) {
    return rosterApiError(error, "Adding someone to the club team");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
