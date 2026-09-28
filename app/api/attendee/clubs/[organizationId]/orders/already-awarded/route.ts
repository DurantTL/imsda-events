import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubOrderApiError } from "@/modules/club-orders/api-errors";
import { markNeedsAlreadyAwarded } from "@/modules/club-orders/repository";
import { clubOrderAwardInputSchema } from "@/modules/club-orders/schemas";
import { requireClubSupplyEditAccess } from "@/modules/club-supplies/access";

type RouteContext = { params: Promise<{ organizationId: string }> };

/**
 * "Already handed out" (#487): marks selected NEEDED needs awarded without
 * touching stock, for honors a club handed out before it ordered here.
 * Directors and deputies only; audited with a count. Never automatic.
 */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId } = await context.params;
    const actor = await requireClubSupplyEditAccess(organizationId);
    const { needIds } = clubOrderAwardInputSchema.parse(await request.json());
    return Response.json(await markNeedsAlreadyAwarded(organizationId, needIds, actor));
  } catch (error) {
    return clubOrderApiError(error, "Marking needs already handed out");
  }
}

export const POST = withRequestContext(postHandler);
