import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { getEventDeletionPreview } from "@/modules/events/deletion-repository";
import { findActiveMembership } from "@/modules/events/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

/** What deleting this event would remove, and whether the caller may do it. */
async function getHandler(
  _request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    const preview = await getEventDeletionPreview(eventId, { userId: access.user.id, globalRole: access.user.globalRole });
    if (!preview) return Response.json({ error: "EVENT_NOT_FOUND", message: "That event no longer exists." }, { status: 404 });
    return Response.json({ preview });
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    logError("Event deletion preview failed", error);
    return Response.json({ error: "EVENT_REQUEST_FAILED", message: "The deletion summary could not be loaded." }, { status: 500 });
  }
}

export const GET = withRequestContext(getHandler);
