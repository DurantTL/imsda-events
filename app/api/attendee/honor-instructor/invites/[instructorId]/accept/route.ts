import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { instructorApiError, requireInstructorAccount } from "@/modules/honors/instructor-api";
import { acceptInstructorInvite } from "@/modules/honors/instructor-repository";

/** The invited person accepts from their own account (#833); their verified email must be the invite's. */
async function postHandler(request: Request, context: { params: Promise<{ instructorId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const account = await requireInstructorAccount();
    const { instructorId } = await context.params;
    await acceptInstructorInvite(instructorId, { id: account.id, verifiedEmail: account.verifiedEmail });
    return Response.json({ ok: true, classesUrl: "/account/instructor" });
  } catch (error) {
    return instructorApiError(error, "Accepting an instructor invite");
  }
}

export const POST = withRequestContext(postHandler);
