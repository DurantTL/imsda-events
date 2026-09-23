import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { honorApiError } from "@/modules/honors/api-errors";
import { requireHonorPermission } from "@/modules/honors/access";
import { deleteHonorSession, updateHonorSession } from "@/modules/honors/repository";
import { honorSessionUpdateSchema } from "@/modules/honors/schemas";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ eventId: string; sessionId: string }> };

async function patchHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, sessionId } = await context.params;
    const access = await requireHonorPermission(eventId);
    const input = honorSessionUpdateSchema.parse(await request.json());
    return Response.json(await updateHonorSession(eventId, sessionId, input, access.user.id));
  } catch (error) {
    return honorApiError(error, "Updating a session");
  }
}

async function deleteHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, sessionId } = await context.params;
    const access = await requireHonorPermission(eventId);
    return Response.json(await deleteHonorSession(eventId, sessionId, access.user.id));
  } catch (error) {
    return honorApiError(error, "Removing a session");
  }
}

export const PATCH = withRequestContext(patchHandler);
export const DELETE = withRequestContext(deleteHandler);
