import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { backgroundCheckApiError } from "@/modules/background-checks/api-errors";
import { listNameOnlyBackgroundCheckMatches, rejectNameOnlyBackgroundCheckMatch } from "@/modules/background-checks/repository";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ matchId: string }> };

/**
 * "Not the same person" (#598): undoes a match made on the name alone. The row
 * goes back to unmatched and stays there on later refreshes. 404 for a match
 * that no longer exists, 400 for one that wasn't made on the name alone.
 * Staff-only.
 */
async function deleteHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { matchId } = await context.params;
    await rejectNameOnlyBackgroundCheckMatch(matchId, actor.id);
    return Response.json({ matches: await listNameOnlyBackgroundCheckMatches() });
  } catch (error) {
    return backgroundCheckApiError(error, "Rejecting a background check name-only match");
  }
}

export const DELETE = withRequestContext(deleteHandler);
