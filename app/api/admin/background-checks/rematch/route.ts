import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { backgroundCheckApiError } from "@/modules/background-checks/api-errors";
import { rematchBackgroundCheckList } from "@/modules/background-checks/repository";
import { withRequestContext } from "@/lib/request-context";

/**
 * The staff Refresh (#598): re-runs matching for the whole current list under
 * the current rules, with no new upload. Staff decisions are kept. 409 while an
 * upload is in progress. Staff-only.
 */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    await requireSystemAdministrator();
    await rematchBackgroundCheckList();
    return Response.json({ ok: true });
  } catch (error) {
    return backgroundCheckApiError(error, "Re-matching the background check list");
  }
}

export const POST = withRequestContext(postHandler);
