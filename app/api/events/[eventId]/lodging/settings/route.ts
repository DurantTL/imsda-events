import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { lodgingApiError } from "@/modules/lodging/api-errors";
import { getStaffLodgingRequestsView, updateLodgingSettings } from "@/modules/lodging/preferences-service";
import { requireLodgingStaff } from "@/modules/lodging/staff-access";
import { withRequestContext } from "@/lib/request-context";

/** Whether registrants choose lodging, the change deadline, and what a full type shows. Event setup permission. */
async function patchHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const staff = await requireLodgingStaff(eventId, "CONFIGURE_EVENT");
    const result = await updateLodgingSettings(eventId, staff.userId, await request.json());
    // The settings permission alone does not open the guests' requests: send the staff view only to someone who may read it.
    const requests = staff.has("MANAGE_REGISTRATION") ? await getStaffLodgingRequestsView(eventId, { canSeeSensitive: staff.canSeeSensitive }) : undefined;
    return Response.json({ result, ...(requests ? { requests } : {}) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return lodgingApiError(error, "Saving the lodging settings");
  }
}

export const PATCH = withRequestContext(patchHandler);
