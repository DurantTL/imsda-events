import { withRequestContext } from "@/lib/request-context";
import { requireClubSupplyAccess } from "@/modules/club-supplies/access";
import { clubSupplyApiError } from "@/modules/club-supplies/api-errors";
import { listClubStock } from "@/modules/club-supplies/repository";

type RouteContext = { params: Promise<{ organizationId: string }> };

/** A club's supply stock (#531): directors and deputies edit, registrars and Area Coordinators view. */
async function getHandler(_request: Request, context: RouteContext) {
  try {
    const { organizationId } = await context.params;
    const access = await requireClubSupplyAccess(organizationId);
    return Response.json({ stock: await listClubStock(organizationId), canEdit: access.mode === "EDIT" });
  } catch (error) {
    return clubSupplyApiError(error, "Loading club supplies");
  }
}

export const GET = withRequestContext(getHandler);
