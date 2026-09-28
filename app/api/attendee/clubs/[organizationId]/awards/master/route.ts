import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubOrderApiError } from "@/modules/club-orders/api-errors";
import { requireClubSupplyEditAccess } from "@/modules/club-supplies/access";
import { addMasterAwardNeeds } from "@/modules/earned-awards/order-source";
import { addMasterAwardsSchema } from "@/modules/earned-awards/schemas";

type RouteContext = { params: Promise<{ organizationId: string }> };

/**
 * Adds a Master Award for members who reached it (#532): eligibility is
 * re-checked against the stored rule and their honor records. Directors and
 * deputies only.
 */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId } = await context.params;
    const actor = await requireClubSupplyEditAccess(organizationId);
    const body = addMasterAwardsSchema.parse(await request.json());
    return Response.json(await addMasterAwardNeeds(organizationId, body, actor));
  } catch (error) {
    return clubOrderApiError(error, "Adding Master Awards");
  }
}

export const POST = withRequestContext(postHandler);
