import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { EventOperationError, findActiveMembership, publishEvent } from "@/modules/events/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

function apiError(error: unknown) {
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof EventOperationError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.code === "EVENT_NOT_FOUND" ? 404 : 409 },
    );
  }
  logError("Event publish failed", error);
  return Response.json({ error: "EVENT_PUBLISH_FAILED", message: "The event could not be published." }, { status: 500 });
}

async function postHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    const event = await publishEvent(eventId, access.user.id);
    return event
      ? Response.json({ event })
      : Response.json({ error: "EVENT_NOT_FOUND", message: "That event no longer exists." }, { status: 404 });
  } catch (error) { return apiError(error); }
}

export const POST = withRequestContext(postHandler);
