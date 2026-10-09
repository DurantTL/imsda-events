import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireHonorPermission } from "@/modules/honors/access";
import { instructorApiError, instructorInviteSchema } from "@/modules/honors/instructor-api";
import { inviteHonorInstructor, listHonorInstructors } from "@/modules/honors/instructor-repository";

/** Staff list the event's instructors and invite one to chosen classes (#833). CONFIGURE_EVENT on this event. */
async function getHandler(_request: Request, context: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await context.params;
    await requireHonorPermission(eventId);
    return Response.json(await listHonorInstructors(eventId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return instructorApiError(error, "Listing instructors");
  }
}

async function postHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requireHonorPermission(eventId);
    const input = instructorInviteSchema.parse(await request.json());
    return Response.json(await inviteHonorInstructor(eventId, input, access.user.id), { status: 201 });
  } catch (error) {
    return instructorApiError(error, "Inviting an instructor");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
