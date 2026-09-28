import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubOrderApiError } from "@/modules/club-orders/api-errors";
import { requireClubSupplyEditAccess } from "@/modules/club-supplies/access";
import { confirmInsignia } from "@/modules/earned-awards/order-source";
import { confirmInsigniaSchema } from "@/modules/earned-awards/schemas";

type RouteContext = { params: Promise<{ organizationId: string }> };

/**
 * Confirms suggested class insignia (#532): only the items the director left
 * ticked are added. Directors and deputies only.
 */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId } = await context.params;
    const actor = await requireClubSupplyEditAccess(organizationId);
    const body = confirmInsigniaSchema.parse(await request.json());
    return Response.json(await confirmInsignia(organizationId, body.confirmations, actor));
  } catch (error) {
    return clubOrderApiError(error, "Confirming class insignia");
  }
}

export const POST = withRequestContext(postHandler);
