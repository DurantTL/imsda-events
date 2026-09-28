import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubOrderApiError } from "@/modules/club-orders/api-errors";
import { requireClubSupplyAccess, requireClubSupplyEditAccess } from "@/modules/club-supplies/access";
import { loadUniformWorkspace, recordUniformNeeds } from "@/modules/uniforms/order-source";
import { recordUniformNeedsSchema } from "@/modules/uniforms/schemas";

type RouteContext = { params: Promise<{ organizationId: string }> };

/**
 * A club's uniform needs (#497): who needs what and where it stands, names
 * and the item and size only. Directors and deputies also get the catalog
 * picker and the member list; registrars and Area Coordinators read the open
 * needs, the same gate as the order list. Reads only.
 */
async function getHandler(_request: Request, context: RouteContext) {
  try {
    const { organizationId } = await context.params;
    const access = await requireClubSupplyAccess(organizationId);
    return Response.json({
      ...(await loadUniformWorkspace(organizationId, { forEditing: access.mode === "EDIT" })),
      canEdit: access.mode === "EDIT",
    });
  } catch (error) {
    return clubOrderApiError(error, "Loading uniform needs");
  }
}

/** Records uniform needs in bulk (#497): directors and deputies only. */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId } = await context.params;
    const actor = await requireClubSupplyEditAccess(organizationId);
    const input = recordUniformNeedsSchema.parse(await request.json());
    return Response.json(await recordUniformNeeds(organizationId, input, actor));
  } catch (error) {
    return clubOrderApiError(error, "Recording uniform needs");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
