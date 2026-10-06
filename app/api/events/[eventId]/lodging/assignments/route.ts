import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { lodgingApiError } from "@/modules/lodging/api-errors";
import { applyAssignmentAction } from "@/modules/lodging/assignment-service";
import { getAssignmentWorkspace } from "@/modules/lodging/assignment-view";
import { requireLodgingStaff } from "@/modules/lodging/staff-access";
import { withRequestContext } from "@/lib/request-context";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };

/**
 * The staff assignment workspace (#200): rooms with who is in them night by night, the people, the exceptions and the
 * waitlist. MANAGE_REGISTRATION. Accessibility flags are in the response only for staff with VIEW_SENSITIVE_DATA.
 */
async function getHandler(_request: Request, context: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await context.params;
    const staff = await requireLodgingStaff(eventId, "MANAGE_REGISTRATION");
    return Response.json({ workspace: await getAssignmentWorkspace(eventId, { canSeeSensitive: staff.canSeeSensitive }) }, { headers: noStore });
  } catch (error) {
    return lodgingApiError(error, "Loading lodging assignments");
  }
}

/**
 * One staff assignment action: place (assign or move, one or a batch), cancel, late arrival or early departure,
 * transfer, or release the rooms of registrations that are no longer active. The server decides capacity, night by
 * night, under the unit locks; nothing here changes a registration's charge or sends a message.
 */
async function postHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const staff = await requireLodgingStaff(eventId, "MANAGE_REGISTRATION");
    const result = await applyAssignmentAction(eventId, staff.userId, await request.json());
    return Response.json({ result, workspace: await getAssignmentWorkspace(eventId, { canSeeSensitive: staff.canSeeSensitive }) }, { headers: noStore });
  } catch (error) {
    return lodgingApiError(error, "Saving the lodging assignment");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
