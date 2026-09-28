import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubOrderApiError } from "@/modules/club-orders/api-errors";
import { clubOrderAwardInputSchema } from "@/modules/club-orders/schemas";
import { requireClubSupplyEditAccess } from "@/modules/club-supplies/access";
import { removeUniformNeeds } from "@/modules/uniforms/order-source";

type RouteContext = { params: Promise<{ organizationId: string }> };

/**
 * Removes uniform needs entered by mistake (#497): only ones still "needed",
 * never anything already on an order or issued. Directors and deputies only;
 * audited with a count.
 */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId } = await context.params;
    const actor = await requireClubSupplyEditAccess(organizationId);
    const { needIds } = clubOrderAwardInputSchema.parse(await request.json());
    return Response.json(await removeUniformNeeds(organizationId, needIds, actor));
  } catch (error) {
    return clubOrderApiError(error, "Removing uniform needs");
  }
}

export const POST = withRequestContext(postHandler);
