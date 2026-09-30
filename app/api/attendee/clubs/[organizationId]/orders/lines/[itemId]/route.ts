import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubOrderApiError } from "@/modules/club-orders/api-errors";
import { setOrderListQuantity } from "@/modules/club-orders/repository";
import { clubOrderListQuantitySchema } from "@/modules/club-orders/schemas";
import { requireClubSupplyEditAccess } from "@/modules/club-supplies/access";

type RouteContext = { params: Promise<{ organizationId: string; itemId: string }> };

/**
 * Changes one line of the order helper list (#654): a quantity (0 takes the
 * item off the list, a positive number adds or changes it) or `null` to put
 * the line back to what honors, uniforms and awards call for. Directors and
 * deputies only.
 */
async function putHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, itemId } = await context.params;
    const actor = await requireClubSupplyEditAccess(organizationId);
    const { quantity } = clubOrderListQuantitySchema.parse(await request.json());
    return Response.json({ line: await setOrderListQuantity(organizationId, itemId, quantity, actor) });
  } catch (error) {
    return clubOrderApiError(error, "Saving the order list");
  }
}

export const PUT = withRequestContext(putHandler);
