import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubOrderApiError } from "@/modules/club-orders/api-errors";
import { requireClubSupplyEditAccess } from "@/modules/club-supplies/access";
import { confirmEventPatches } from "@/modules/earned-awards/order-source";
import { confirmEventPatchesSchema } from "@/modules/earned-awards/schemas";

type RouteContext = { params: Promise<{ organizationId: string }> };

/**
 * Confirms a suggested event patch (#532) for the chosen members, who must have
 * attended the event. Directors and deputies only.
 */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId } = await context.params;
    const actor = await requireClubSupplyEditAccess(organizationId);
    const body = confirmEventPatchesSchema.parse(await request.json());
    return Response.json(await confirmEventPatches(organizationId, body, actor));
  } catch (error) {
    return clubOrderApiError(error, "Confirming event patches");
  }
}

export const POST = withRequestContext(postHandler);
