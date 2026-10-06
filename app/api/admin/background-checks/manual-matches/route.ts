import { requireSystemAdministrator } from "@/modules/organizations/access";
import { backgroundCheckApiError } from "@/modules/background-checks/api-errors";
import { listManualBackgroundCheckMatches } from "@/modules/background-checks/repository";
import { withRequestContext } from "@/lib/request-context";

/**
 * Background-check matches staff made by hand (#527): a staff decision that
 * holds across refreshes and uploads until staff undo it. Staff-only.
 */
async function getHandler() {
  try {
    await requireSystemAdministrator();
    return Response.json({ matches: await listManualBackgroundCheckMatches() });
  } catch (error) {
    return backgroundCheckApiError(error, "Loading Sterling Volunteers matches made by hand");
  }
}

export const GET = withRequestContext(getHandler);
