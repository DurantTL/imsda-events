import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { backgroundCheckApiError } from "@/modules/background-checks/api-errors";
import { listManualBackgroundCheckMatches, undoManualBackgroundCheckMatch } from "@/modules/background-checks/repository";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ matchId: string }> };

/**
 * Undo a background-check match made by hand (#527): the automatic rules
 * apply to that person again. 404 for a match that no longer exists, 400 for
 * one that wasn't made by hand. Staff-only.
 */
async function deleteHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { matchId } = await context.params;
    await undoManualBackgroundCheckMatch(matchId, actor.id);
    return Response.json({ matches: await listManualBackgroundCheckMatches() });
  } catch (error) {
    return backgroundCheckApiError(error, "Undoing a background check match");
  }
}

export const DELETE = withRequestContext(deleteHandler);
