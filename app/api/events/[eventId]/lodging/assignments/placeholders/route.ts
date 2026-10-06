import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { lodgingApiError } from "@/modules/lodging/api-errors";
import { applyPlaceholderAction } from "@/modules/lodging/assignment-service";
import { getAssignmentWorkspace } from "@/modules/lodging/assignment-view";
import { requireLodgingStaff } from "@/modules/lodging/staff-access";
import { withRequestContext } from "@/lib/request-context";

/** Expected guests (staff, pastors, a club) who are not registered yet: add, link to a registration later, archive. MANAGE_REGISTRATION. */
async function postHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const staff = await requireLodgingStaff(eventId, "MANAGE_REGISTRATION");
    const result = await applyPlaceholderAction(eventId, staff.userId, await request.json());
    return Response.json({ result, workspace: await getAssignmentWorkspace(eventId, { canSeeSensitive: staff.canSeeSensitive }) }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    return lodgingApiError(error, "Saving the expected guest");
  }
}

export const POST = withRequestContext(postHandler);
