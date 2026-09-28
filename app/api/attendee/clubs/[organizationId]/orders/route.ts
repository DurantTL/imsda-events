import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubOrderApiError } from "@/modules/club-orders/api-errors";
import { createOrderBatch, listOrderList } from "@/modules/club-orders/repository";
import { clubOrderBatchInputSchema } from "@/modules/club-orders/schemas";
import { requireClubSupplyAccess, requireClubSupplyEditAccess } from "@/modules/club-supplies/access";
import { syncHonorOrderNeeds } from "@/modules/honors/order-source";

type RouteContext = { params: Promise<{ organizationId: string }> };

/**
 * A club's order list (#487): every completed-but-not-ordered honor, grouped
 * by catalog item, with stock applied. Syncing first means a completion
 * recorded since the last visit shows up with no manual comparison against
 * a prior file. Directors and deputies edit; registrars and Area
 * Coordinators view, the same gate as club supplies (#531).
 */
async function getHandler(_request: Request, context: RouteContext) {
  try {
    const { organizationId } = await context.params;
    const access = await requireClubSupplyAccess(organizationId);
    await syncHonorOrderNeeds(organizationId);
    const { lines, unmatched } = await listOrderList(organizationId);
    return Response.json({ lines, unmatched, canEdit: access.mode === "EDIT" });
  } catch (error) {
    return clubOrderApiError(error, "Loading the order list");
  }
}

/** Places an order (#487): directors and deputies only. */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId } = await context.params;
    const actor = await requireClubSupplyEditAccess(organizationId);
    await syncHonorOrderNeeds(organizationId);
    const { extras } = clubOrderBatchInputSchema.parse(await request.json());
    return Response.json(await createOrderBatch(organizationId, extras, actor));
  } catch (error) {
    return clubOrderApiError(error, "Placing the order");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
