import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubOrderApiError } from "@/modules/club-orders/api-errors";
import { requireClubSupplyAccess, requireClubSupplyEditAccess } from "@/modules/club-supplies/access";
import { loadEarnedAwardsWorkspace, recordAwardNeeds } from "@/modules/earned-awards/order-source";
import { recordAwardNeedsSchema } from "@/modules/earned-awards/schemas";

type RouteContext = { params: Promise<{ organizationId: string }> };

/**
 * A club's earned awards (#532): who earned what and where it stands, names
 * and item names only. Directors and deputies also get the picker, the member
 * list and the suggestions; registrars and Area Coordinators read the open
 * items and Master Award progress, the same gate as the order list. Reads only.
 */
async function getHandler(_request: Request, context: RouteContext) {
  try {
    const { organizationId } = await context.params;
    const access = await requireClubSupplyAccess(organizationId);
    return Response.json({
      ...(await loadEarnedAwardsWorkspace(organizationId, { forEditing: access.mode === "EDIT" })),
      canEdit: access.mode === "EDIT",
    });
  } catch (error) {
    return clubOrderApiError(error, "Loading earned awards");
  }
}

/** Records earned items by hand in bulk (Good Conduct, TLT...): directors and deputies only. */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId } = await context.params;
    const actor = await requireClubSupplyEditAccess(organizationId);
    const input = recordAwardNeedsSchema.parse(await request.json());
    return Response.json(await recordAwardNeeds(organizationId, input, actor));
  } catch (error) {
    return clubOrderApiError(error, "Recording earned awards");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
