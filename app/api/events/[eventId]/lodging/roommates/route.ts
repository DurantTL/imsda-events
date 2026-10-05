import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { lodgingApiError } from "@/modules/lodging/api-errors";
import { decideRoommateRequest, getStaffLodgingRequestsView } from "@/modules/lodging/preferences-service";
import { requireLodgingStaff } from "@/modules/lodging/staff-access";
import { withRequestContext } from "@/lib/request-context";

/** Staff approve (treat as mutual), decline or withdraw a roommate request, with a reason. */
async function postHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const staff = await requireLodgingStaff(eventId, "MANAGE_REGISTRATION");
    const result = await decideRoommateRequest(eventId, staff.userId, await request.json());
    return Response.json({ result, requests: await getStaffLodgingRequestsView(eventId, { canSeeSensitive: staff.canSeeSensitive }) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return lodgingApiError(error, "Deciding the roommate request");
  }
}

export const POST = withRequestContext(postHandler);
