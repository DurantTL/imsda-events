import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { eventLocationApiError } from "@/modules/event-locations/api-errors";
import { createEventLocation, listEventLocations } from "@/modules/event-locations/repository";
import { findActiveMembership } from "@/modules/events/repository";
import { withRequestContext } from "@/lib/request-context";

async function getHandler(_request: Request, context: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    return Response.json({ locations: await listEventLocations(eventId) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return eventLocationApiError(error, "Loading the event's locations");
  }
}

async function postHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    const location = await createEventLocation(eventId, access.user.id, await request.json());
    return Response.json({ location, locations: await listEventLocations(eventId) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return eventLocationApiError(error, "Adding the location");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
