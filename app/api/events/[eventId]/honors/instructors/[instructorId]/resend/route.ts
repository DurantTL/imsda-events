import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireHonorPermission } from "@/modules/honors/access";
import { instructorApiError } from "@/modules/honors/instructor-api";
import { resendHonorInstructorInvite } from "@/modules/honors/instructor-repository";

/** Staff resend an open instructor invite (#833): one deliberate send to one person, never a bulk send. */
async function postHandler(request: Request, context: { params: Promise<{ eventId: string; instructorId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, instructorId } = await context.params;
    const access = await requireHonorPermission(eventId);
    await resendHonorInstructorInvite(eventId, instructorId, access.user.id);
    return Response.json({ ok: true });
  } catch (error) {
    return instructorApiError(error, "Resending an instructor invite");
  }
}

export const POST = withRequestContext(postHandler);
