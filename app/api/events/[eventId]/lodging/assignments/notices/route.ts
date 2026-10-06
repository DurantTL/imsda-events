import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { lodgingApiError } from "@/modules/lodging/api-errors";
import { getAssignmentWorkspace } from "@/modules/lodging/assignment-view";
import { sendRoomNotice } from "@/modules/lodging/notices";
import { requireLodgingStaff } from "@/modules/lodging/staff-access";
import { withRequestContext } from "@/lib/request-context";

const bodySchema = z.object({ registrationId: z.string().trim().min(1).max(100) }).strict();

/**
 * Send one registration its room notice. One explicit staff action, one registration, never a batch. It needs
 * assignments to be published for the event, and MANAGE_REGISTRATION plus CONFIGURE_EVENT (the same pair as publishing).
 */
async function postHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    await requireLodgingStaff(eventId, "CONFIGURE_EVENT");
    const staff = await requireLodgingStaff(eventId, "MANAGE_REGISTRATION");
    const body = bodySchema.parse(await request.json());
    const result = await sendRoomNotice(eventId, staff.userId, body.registrationId);
    return Response.json({ result, workspace: await getAssignmentWorkspace(eventId, { canSeeSensitive: staff.canSeeSensitive }) }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    return lodgingApiError(error, "Sending the room notice");
  }
}

export const POST = withRequestContext(postHandler);
