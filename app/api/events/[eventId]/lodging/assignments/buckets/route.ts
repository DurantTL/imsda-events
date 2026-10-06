import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { lodgingApiError } from "@/modules/lodging/api-errors";
import { renameBucket } from "@/modules/lodging/assignment-service";
import { getAssignmentWorkspace } from "@/modules/lodging/assignment-view";
import { requireLodgingStaff } from "@/modules/lodging/staff-access";
import { withRequestContext } from "@/lib/request-context";

/** Rename an alternate-housing choice (Hotel, Airbnb, Home, Offsite, Other). It uses no on-site inventory. MANAGE_REGISTRATION. */
async function patchHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const staff = await requireLodgingStaff(eventId, "MANAGE_REGISTRATION");
    const result = await renameBucket(eventId, staff.userId, await request.json());
    return Response.json({ result, workspace: await getAssignmentWorkspace(eventId, { canSeeSensitive: staff.canSeeSensitive }) }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    return lodgingApiError(error, "Renaming the housing choice");
  }
}

export const PATCH = withRequestContext(patchHandler);
