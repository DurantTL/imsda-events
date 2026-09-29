import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { eventLocationApiError } from "@/modules/event-locations/api-errors";
import { reorderEventLocations } from "@/modules/event-locations/repository";
import { findActiveMembership } from "@/modules/events/repository";
import { withRequestContext } from "@/lib/request-context";

async function putHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    return Response.json({ locations: await reorderEventLocations(eventId, access.user.id, await request.json()) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return eventLocationApiError(error, "Reordering the locations");
  }
}

export const PUT = withRequestContext(putHandler);
