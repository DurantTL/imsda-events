import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubOrderApiError } from "@/modules/club-orders/api-errors";
import { markNeedsAwarded } from "@/modules/club-orders/repository";
import { clubOrderAwardInputSchema } from "@/modules/club-orders/schemas";
import { requireClubSupplyEditAccess } from "@/modules/club-supplies/access";

type RouteContext = { params: Promise<{ organizationId: string }> };

/** Marks a group of received needs awarded (#487): stock for each item drops by one per need, never below zero. */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId } = await context.params;
    const actor = await requireClubSupplyEditAccess(organizationId);
    const { needIds } = clubOrderAwardInputSchema.parse(await request.json());
    return Response.json(await markNeedsAwarded(organizationId, needIds, actor));
  } catch (error) {
    return clubOrderApiError(error, "Marking needs awarded");
  }
}

export const POST = withRequestContext(postHandler);
