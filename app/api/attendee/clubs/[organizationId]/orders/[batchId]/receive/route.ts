import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubOrderApiError } from "@/modules/club-orders/api-errors";
import { markOrderBatchReceived } from "@/modules/club-orders/repository";
import { requireClubSupplyEditAccess } from "@/modules/club-supplies/access";

type RouteContext = { params: Promise<{ organizationId: string; batchId: string }> };

/** Marks an order received (#487): the ordered quantity joins the club's stock. */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, batchId } = await context.params;
    const actor = await requireClubSupplyEditAccess(organizationId);
    return Response.json(await markOrderBatchReceived(organizationId, batchId, actor));
  } catch (error) {
    return clubOrderApiError(error, "Marking the order received");
  }
}

export const POST = withRequestContext(postHandler);
