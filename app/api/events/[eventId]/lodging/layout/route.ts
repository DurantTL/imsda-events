import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { lodgingApiError } from "@/modules/lodging/api-errors";
import { getLodgingView, updateEventLayout } from "@/modules/lodging/service";
import { withRequestContext } from "@/lib/request-context";

/** "Update to latest property layout": the only way a newer template version reaches an event. Audited. */
async function postHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    const result = await updateEventLayout(eventId, access.user.id);
    return Response.json({ result, lodging: await getLodgingView(eventId) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return lodgingApiError(error, "Updating the property layout");
  }
}

export const POST = withRequestContext(postHandler);
