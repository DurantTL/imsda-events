import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireClubSupplyEditAccess } from "@/modules/club-supplies/access";
import { clubSupplyApiError } from "@/modules/club-supplies/api-errors";
import { setClubStockQuantity } from "@/modules/club-supplies/repository";
import { clubStockQuantitySchema } from "@/modules/club-supplies/schemas";

type RouteContext = { params: Promise<{ organizationId: string; itemId: string }> };

/** Sets a club's quantity on hand for one catalog item (#531): directors and deputies only. */
async function putHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, itemId } = await context.params;
    const actor = await requireClubSupplyEditAccess(organizationId);
    const { quantityOnHand } = clubStockQuantitySchema.parse(await request.json());
    return Response.json({ stock: await setClubStockQuantity(organizationId, itemId, quantityOnHand, actor) });
  } catch (error) {
    return clubSupplyApiError(error, "Saving club supplies");
  }
}

export const PUT = withRequestContext(putHandler);
