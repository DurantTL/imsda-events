import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { lodgingApiError } from "@/modules/lodging/api-errors";
import { getStaffLodgingRequestsView, saveLodgingRequest } from "@/modules/lodging/preferences-service";
import { requireLodgingStaff } from "@/modules/lodging/staff-access";
import { withRequestContext } from "@/lib/request-context";

/**
 * Staff record or change one registration's lodging request, with a reason, at any time. After the deadline the
 * change is flagged for review. Staff without VIEW_SENSITIVE_DATA cannot read or set the accessibility flags.
 */
async function putHandler(request: Request, context: { params: Promise<{ eventId: string; registrationId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, registrationId } = await context.params;
    const staff = await requireLodgingStaff(eventId, "MANAGE_REGISTRATION");
    const result = await saveLodgingRequest({ eventId, registrationId, actor: { kind: "STAFF", userId: staff.userId, canSeeSensitive: staff.canSeeSensitive }, raw: await request.json() });
    return Response.json({ result, requests: await getStaffLodgingRequestsView(eventId, { canSeeSensitive: staff.canSeeSensitive }) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return lodgingApiError(error, "Saving the lodging request");
  }
}

export const PUT = withRequestContext(putHandler);
