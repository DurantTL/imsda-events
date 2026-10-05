import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { lodgingApiError } from "@/modules/lodging/api-errors";
import { acknowledgeReviewItem, getStaffLodgingRequestsView } from "@/modules/lodging/preferences-service";
import { requireLodgingStaff } from "@/modules/lodging/staff-access";
import { withRequestContext } from "@/lib/request-context";

const noStore = { "Cache-Control": "no-store" };

/** Lodging requests, roommate standing and the review queue for staff who manage registrations. Flags only with VIEW_SENSITIVE_DATA. */
async function getHandler(_request: Request, context: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await context.params;
    const staff = await requireLodgingStaff(eventId, "MANAGE_REGISTRATION");
    return Response.json({ requests: await getStaffLodgingRequestsView(eventId, { canSeeSensitive: staff.canSeeSensitive }) }, { headers: noStore });
  } catch (error) {
    return lodgingApiError(error, "Loading lodging requests");
  }
}

/** Acknowledge one review item (the fingerprint must still match, so a changed item cannot be waved through). */
async function postHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const staff = await requireLodgingStaff(eventId, "MANAGE_REGISTRATION");
    const result = await acknowledgeReviewItem(eventId, { userId: staff.userId, canSeeSensitive: staff.canSeeSensitive }, await request.json());
    return Response.json({ result, requests: await getStaffLodgingRequestsView(eventId, { canSeeSensitive: staff.canSeeSensitive }) }, { headers: noStore });
  } catch (error) {
    return lodgingApiError(error, "Acknowledging the lodging item");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
