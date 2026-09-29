import { requireSystemAdministrator } from "@/modules/organizations/access";
import { backgroundCheckApiError } from "@/modules/background-checks/api-errors";
import { listNameOnlyBackgroundCheckMatches } from "@/modules/background-checks/repository";
import { withRequestContext } from "@/lib/request-context";

/**
 * Background-check rows matched on the name alone because the site didn't
 * match (#598), for a staff spot check. Staff-only.
 */
async function getHandler() {
  try {
    await requireSystemAdministrator();
    return Response.json({ matches: await listNameOnlyBackgroundCheckMatches() });
  } catch (error) {
    return backgroundCheckApiError(error, "Loading background check matches made on the name alone");
  }
}

export const GET = withRequestContext(getHandler);
