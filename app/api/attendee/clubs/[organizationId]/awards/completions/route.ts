import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubOrderApiError } from "@/modules/club-orders/api-errors";
import { requireClubSupplyEditAccess } from "@/modules/club-supplies/access";
import { recordClassCompletions } from "@/modules/earned-awards/order-source";
import { recordClassCompletionsSchema } from "@/modules/earned-awards/schemas";

type RouteContext = { params: Promise<{ organizationId: string }> };

/**
 * Marks members as having completed a class (#532). This only records the
 * completion; it orders nothing. Directors and deputies only.
 */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId } = await context.params;
    const actor = await requireClubSupplyEditAccess(organizationId);
    const body = recordClassCompletionsSchema.parse(await request.json());
    return Response.json(await recordClassCompletions(organizationId, body, actor));
  } catch (error) {
    return clubOrderApiError(error, "Recording completed classes");
  }
}

export const POST = withRequestContext(postHandler);
