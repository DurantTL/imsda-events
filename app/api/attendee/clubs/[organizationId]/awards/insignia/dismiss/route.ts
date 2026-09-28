import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubOrderApiError } from "@/modules/club-orders/api-errors";
import { requireClubSupplyEditAccess } from "@/modules/club-supplies/access";
import { dismissInsignia } from "@/modules/earned-awards/order-source";
import { dismissInsigniaSchema } from "@/modules/earned-awards/schemas";

type RouteContext = { params: Promise<{ organizationId: string }> };

/**
 * "Not now" for a completed class's insignia (#532): it stops being suggested.
 * Directors and deputies only.
 */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId } = await context.params;
    const actor = await requireClubSupplyEditAccess(organizationId);
    const body = dismissInsigniaSchema.parse(await request.json());
    return Response.json(await dismissInsignia(organizationId, body.completionIds, actor));
  } catch (error) {
    return clubOrderApiError(error, "Skipping class insignia");
  }
}

export const POST = withRequestContext(postHandler);
