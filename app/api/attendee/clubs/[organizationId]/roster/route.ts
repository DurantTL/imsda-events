import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { actorAttribution, requireRosterAccess } from "@/modules/club-rosters/access";
import { rosterApiError } from "@/modules/club-rosters/api-errors";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { addRosterMember, listRoster } from "@/modules/club-rosters/repository";
import { rosterMemberInputSchema } from "@/modules/club-rosters/schemas";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ organizationId: string }> };

async function getHandler(_request: Request, context: RouteContext) {
  try {
    const { organizationId } = await context.params;
    await requireRosterAccess(organizationId);
    const clubYear = clubYearFor(new Date());
    return Response.json({ clubYear, members: await listRoster(organizationId, clubYear) });
  } catch (error) {
    return rosterApiError(error, "Loading the roster");
  }
}

async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId } = await context.params;
    const access = await requireRosterAccess(organizationId);
    const input = rosterMemberInputSchema.parse(await request.json());
    const clubYear = clubYearFor(new Date());
    await addRosterMember(organizationId, clubYear, input, actorAttribution(access.actor));
    return Response.json({ clubYear, members: await listRoster(organizationId, clubYear) }, { status: 201 });
  } catch (error) {
    return rosterApiError(error, "Adding a person to the roster");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
