import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { actorAttribution, requireRosterAccess } from "@/modules/club-rosters/access";
import { readRosterJson, rosterApiError } from "@/modules/club-rosters/api-errors";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { requireGuardianEditor, rosterGuardiansForAccess } from "@/modules/club-rosters/guardians-access";
import { listRoster, removeRosterMember, updateRosterMember } from "@/modules/club-rosters/repository";
import { rosterMemberUpdateSchema, rosterRemoveSchema } from "@/modules/club-rosters/schemas";
import { refreshBackgroundCheckMatchesSafely } from "@/modules/background-checks/refresh-after-write";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ organizationId: string; memberId: string }> };

async function roster(access: Parameters<typeof rosterGuardiansForAccess>[0], organizationId: string) {
  const clubYear = clubYearFor(new Date());
  // Guardian contacts (#510) ride along for a director or deputy only.
  const guardians = await rosterGuardiansForAccess(access, organizationId, clubYear);
  return { clubYear, members: await listRoster(organizationId, clubYear), ...(guardians ? { guardians } : {}) };
}

async function patchHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, memberId } = await context.params;
    const access = await requireRosterAccess(organizationId);
    const input = rosterMemberUpdateSchema.parse(await readRosterJson(request));
    // Only a director or deputy may send guardian contacts; a registrar gets a 403, not a silent drop.
    if (input.guardians !== undefined) requireGuardianEditor(access);
    // A details edit must leave the person with a gender (#424); status-only edits are exempt.
    const { personId } = await updateRosterMember(organizationId, memberId, input, actorAttribution(access.actor), undefined, { requireGender: true });
    // #527: a name change or other edit is matched against the background
    // check list right away, without waiting on the next upload.
    await refreshBackgroundCheckMatchesSafely([personId]);
    return Response.json(await roster(access, organizationId));
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
    // #527: leaving a roster can change who a Sterling Volunteers entry matches.
    await refreshBackgroundCheckMatchesSafely([removed?.personId]);
    return Response.json({ ...(await roster(access, organizationId)), nameKept: removed?.nameKept ?? false });
  } catch (error) {
    return rosterApiError(error, "Removing a person from the roster");
  }
}

export const PATCH = withRequestContext(patchHandler);
export const DELETE = withRequestContext(deleteHandler);
