import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { eventLocationApiError } from "@/modules/event-locations/api-errors";
import { deleteEventLocation, listEventLocations, updateEventLocation } from "@/modules/event-locations/repository";
import { findActiveMembership } from "@/modules/events/repository";
import { withRequestContext } from "@/lib/request-context";

type Context = { params: Promise<{ eventId: string; locationId: string }> };

async function patchHandler(request: Request, context: Context) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, locationId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    const location = await updateEventLocation(eventId, locationId, access.user.id, await request.json());
    return Response.json({ location, locations: await listEventLocations(eventId) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return eventLocationApiError(error, "Updating the location");
  }
}

async function deleteHandler(request: Request, context: Context) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, locationId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    return Response.json({ locations: await deleteEventLocation(eventId, locationId, access.user.id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return eventLocationApiError(error, "Deleting the location");
  }
}

export const PATCH = withRequestContext(patchHandler);
export const DELETE = withRequestContext(deleteHandler);
