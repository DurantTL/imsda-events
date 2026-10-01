import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { organizationApiError } from "@/modules/organizations/api-errors";
import { runChurchGeocoding } from "@/modules/organizations/church-geocoding";

/**
 * "Find map locations" (#724): looks up map points for churches that have a
 * street address and no point yet, and stores the results for review. System
 * administrators only, and only when GEOCODING_ENABLED is on. If the geocoding
 * service can't be reached, nothing is changed and the response says so.
 */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const summary = await runChurchGeocoding(actor.id);
    return Response.json(summary, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return organizationApiError(error, "Finding church map locations");
  }
}

export const POST = withRequestContext(postHandler);
