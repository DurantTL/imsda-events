import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { actorAttribution, requireRosterAccess } from "@/modules/club-rosters/access";
import { readRosterJson, rosterApiError } from "@/modules/club-rosters/api-errors";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { listRoster, removeRosterMember, updateRosterMember } from "@/modules/club-rosters/repository";
import { rosterMemberUpdateSchema, rosterRemoveSchema } from "@/modules/club-rosters/schemas";
import { refreshBackgroundCheckMatchesSafely } from "@/modules/background-checks/refresh-after-write";
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
    const input = rosterMemberUpdateSchema.parse(await readRosterJson(request));
    // A details edit must leave the person with a gender (#424); status-only edits are exempt.
    const { personId } = await updateRosterMember(organizationId, memberId, input, actorAttribution(access.actor), undefined, { requireGender: true });
    // #527: a name change or other edit is matched against the background
    // check list right away, without waiting on the next upload.
    await refreshBackgroundCheckMatchesSafely([personId]);
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
    rosterRemoveSchema.parse(await readRosterJson(request));
    const removed = await removeRosterMember(organizationId, memberId, actorAttribution(access.actor));
    // #527: leaving a roster can change who a background-check entry matches.
    await refreshBackgroundCheckMatchesSafely([removed?.personId]);
    return Response.json(await roster(organizationId));
  } catch (error) {
    return rosterApiError(error, "Removing a person from the roster");
  }
}

export const PATCH = withRequestContext(patchHandler);
export const DELETE = withRequestContext(deleteHandler);
