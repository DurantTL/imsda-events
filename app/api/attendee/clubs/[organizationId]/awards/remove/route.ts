import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubOrderApiError } from "@/modules/club-orders/api-errors";
import { clubOrderAwardInputSchema } from "@/modules/club-orders/schemas";
import { requireClubSupplyEditAccess } from "@/modules/club-supplies/access";
import { removeAwardNeeds } from "@/modules/earned-awards/order-source";

type RouteContext = { params: Promise<{ organizationId: string }> };

/**
 * Removes earned items entered by mistake (#532): only ones still "needed",
 * never anything already on an order or awarded. Directors and deputies only;
 * audited with a count.
 */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId } = await context.params;
    const actor = await requireClubSupplyEditAccess(organizationId);
    const body = clubOrderAwardInputSchema.parse(await request.json());
    return Response.json(await removeAwardNeeds(organizationId, body.needIds, actor));
  } catch (error) {
    return clubOrderApiError(error, "Removing earned awards");
  }
}

export const POST = withRequestContext(postHandler);
