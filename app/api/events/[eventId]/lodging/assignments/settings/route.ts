import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { lodgingApiError } from "@/modules/lodging/api-errors";
import { updateAssignmentSettings } from "@/modules/lodging/assignment-service";
import { getAssignmentWorkspace } from "@/modules/lodging/assignment-view";
import { requireLodgingStaff } from "@/modules/lodging/staff-access";
import { withRequestContext } from "@/lib/request-context";

/**
 * Show room assignments to attendees (off by default), show roommates' first names (off by default), and the
 * instructions beside an assignment. Publishing needs MANAGE_REGISTRATION plus CONFIGURE_EVENT, both checked here.
 */
async function patchHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    await requireLodgingStaff(eventId, "CONFIGURE_EVENT");
    const staff = await requireLodgingStaff(eventId, "MANAGE_REGISTRATION");
    const result = await updateAssignmentSettings(eventId, staff.userId, await request.json());
    return Response.json({ result, workspace: await getAssignmentWorkspace(eventId, { canSeeSensitive: staff.canSeeSensitive }) }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    return lodgingApiError(error, "Saving the attendee display settings");
  }
}

export const PATCH = withRequestContext(patchHandler);
