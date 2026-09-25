import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { organizationApiError } from "@/modules/organizations/api-errors";
import { updateChurchLocation } from "@/modules/organizations/church-location-repository";
import { churchLocationInputSchema } from "@/modules/organizations/church-location-schemas";
import { withRequestContext } from "@/lib/request-context";

/**
 * Conference staff save a church's town and hand-entered coordinates
 * (#437). Gated the same as any other organization edit — no looser
 * permission for map data. Audited, without the coordinates themselves.
 */
async function patchHandler(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { organizationId } = await context.params;
    const input = churchLocationInputSchema.parse(await request.json());
    return Response.json({ location: await updateChurchLocation(organizationId, input, actor.id) });
  } catch (error) {
    return organizationApiError(error, "Saving a church location");
  }
}

export const PATCH = withRequestContext(patchHandler);
