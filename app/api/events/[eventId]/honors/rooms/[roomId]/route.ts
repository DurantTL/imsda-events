import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { honorApiError } from "@/modules/honors/api-errors";
import { requireHonorPermission } from "@/modules/honors/access";
import { deleteHonorRoom, updateHonorRoom } from "@/modules/honors/schedule-repository";
import { honorRoomUpdateSchema } from "@/modules/honors/schedule-schemas";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ eventId: string; roomId: string }> };

async function patchHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, roomId } = await context.params;
    const access = await requireHonorPermission(eventId);
    const input = honorRoomUpdateSchema.parse(await request.json());
    return Response.json(await updateHonorRoom(eventId, roomId, input, access.user.id));
  } catch (error) {
    return honorApiError(error, "Updating a room");
  }
}

async function deleteHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, roomId } = await context.params;
    const access = await requireHonorPermission(eventId);
    return Response.json(await deleteHonorRoom(eventId, roomId, access.user.id));
  } catch (error) {
    return honorApiError(error, "Removing a room");
  }
}

export const PATCH = withRequestContext(patchHandler);
export const DELETE = withRequestContext(deleteHandler);
