import { withRequestContext } from "@/lib/request-context";
import { clubOrderApiError } from "@/modules/club-orders/api-errors";
import { loadOrderWorkspace } from "@/modules/club-orders/repository";
import { requireClubSupplyAccess } from "@/modules/club-supplies/access";
import { syncHonorOrderNeeds } from "@/modules/honors/order-source";

type RouteContext = { params: Promise<{ organizationId: string }> };

/**
 * A club's order helper list (#487, #654): every completed-but-not-handed-out
 * honor, uniform and award, grouped by catalog item, with the club's stock
 * applied. Syncing first means a completion recorded since the last visit
 * shows up with no manual comparison against a prior file. Directors and
 * deputies edit (and their visit syncs); registrars and Area Coordinators
 * view what's on file and never write, the same gate as club supplies (#531).
 * The list is a planning aid: nothing is ordered from here.
 */
async function getHandler(_request: Request, context: RouteContext) {
  try {
    const { organizationId } = await context.params;
    const access = await requireClubSupplyAccess(organizationId);
    // Only an editor's visit records new needs; a view-only role reads what's on file.
    if (access.mode === "EDIT") await syncHonorOrderNeeds(organizationId);
    return Response.json({ ...(await loadOrderWorkspace(organizationId)), canEdit: access.mode === "EDIT" });
  } catch (error) {
    return clubOrderApiError(error, "Loading the order list");
  }
}

export const GET = withRequestContext(getHandler);
