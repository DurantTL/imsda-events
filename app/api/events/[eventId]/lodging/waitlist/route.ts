import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { lodgingApiError } from "@/modules/lodging/api-errors";
import { getAssignmentWorkspace } from "@/modules/lodging/assignment-view";
import { requireLodgingStaff } from "@/modules/lodging/staff-access";
import { applyWaitlistAction } from "@/modules/lodging/waitlist-service";
import { withRequestContext } from "@/lib/request-context";

/**
 * Staff lodging waitlist actions (#200): join, offer, record an answer, remove, promote into a room, record lapsed
 * offers. An offer (even its preview) and a promotion need MANAGE_REGISTRATION plus CONFIGURE_EVENT; everything else
 * needs MANAGE_REGISTRATION. An offer sends one email per entry, only when `confirm` is true, only from this action.
 */
async function postHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const staff = await requireLodgingStaff(eventId, "MANAGE_REGISTRATION");
    const body = await request.json();
    const action = (body as { action?: unknown } | null)?.action;
    if (action === "offer" || action === "promote") await requireLodgingStaff(eventId, "CONFIGURE_EVENT");
    const result = await applyWaitlistAction(eventId, staff.userId, body);
    return Response.json({ result, workspace: await getAssignmentWorkspace(eventId, { canSeeSensitive: staff.canSeeSensitive }) }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    return lodgingApiError(error, "Updating the lodging waitlist");
  }
}

export const POST = withRequestContext(postHandler);
