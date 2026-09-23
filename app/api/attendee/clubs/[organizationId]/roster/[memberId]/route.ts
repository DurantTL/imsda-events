import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireRosterAccess } from "@/modules/club-rosters/access";
import { rosterApiError } from "@/modules/club-rosters/api-errors";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { listRoster, removeRosterMember, updateRosterMember } from "@/modules/club-rosters/repository";
import { rosterMemberUpdateSchema, rosterRemoveSchema } from "@/modules/club-rosters/schemas";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ organizationId: string; memberId: string }> };

async function roster(organizationId: string) {
  const clubYear = clubYearFor(new Date());
  return { clubYear, members: await listRoster(organizationId, clubYear) };
}

async function patchHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, memberId } = await context.params;
    const access = await requireRosterAccess(organizationId);
    const input = rosterMemberUpdateSchema.parse(await request.json());
    await updateRosterMember(organizationId, memberId, input, { accountId: access.accountId });
    return Response.json(await roster(organizationId));
  } catch (error) {
    return rosterApiError(error, "Updating a roster entry");
  }
}

async function deleteHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, memberId } = await context.params;
    const access = await requireRosterAccess(organizationId);
    rosterRemoveSchema.parse(await request.json());
    await removeRosterMember(organizationId, memberId, { accountId: access.accountId });
    return Response.json(await roster(organizationId));
  } catch (error) {
    return rosterApiError(error, "Removing a person from the roster");
  }
}

export const PATCH = withRequestContext(patchHandler);
export const DELETE = withRequestContext(deleteHandler);
