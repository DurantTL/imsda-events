import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireHonorPermission } from "@/modules/honors/access";
import { instructorApiError, instructorClassesSchema } from "@/modules/honors/instructor-api";
import { removeHonorInstructor, setHonorInstructorClasses } from "@/modules/honors/instructor-repository";

type Context = { params: Promise<{ eventId: string; instructorId: string }> };

/** Staff change the classes an instructor teaches (#833). */
async function patchHandler(request: Request, context: Context) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, instructorId } = await context.params;
    const access = await requireHonorPermission(eventId);
    const input = instructorClassesSchema.parse(await request.json());
    await setHonorInstructorClasses(eventId, instructorId, input.offeringIds, access.user.id);
    return Response.json({ ok: true });
  } catch (error) {
    return instructorApiError(error, "Changing an instructor's classes");
  }
}

/** Staff take an instructor's access away (#833). */
async function deleteHandler(request: Request, context: Context) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, instructorId } = await context.params;
    const access = await requireHonorPermission(eventId);
    await removeHonorInstructor(eventId, instructorId, access.user.id);
    return Response.json({ ok: true });
  } catch (error) {
    return instructorApiError(error, "Removing an instructor");
  }
}

export const PATCH = withRequestContext(patchHandler);
export const DELETE = withRequestContext(deleteHandler);
