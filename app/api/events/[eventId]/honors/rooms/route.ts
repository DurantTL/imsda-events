import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { honorApiError } from "@/modules/honors/api-errors";
import { requireHonorPermission } from "@/modules/honors/access";
import { createHonorRoom } from "@/modules/honors/schedule-repository";
import { honorRoomInputSchema } from "@/modules/honors/schedule-schemas";
import { withRequestContext } from "@/lib/request-context";

async function postHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requireHonorPermission(eventId);
    const input = honorRoomInputSchema.parse(await request.json());
    return Response.json(await createHonorRoom(eventId, input, access.user.id), { status: 201 });
  } catch (error) {
    return honorApiError(error, "Adding a room");
  }
}

export const POST = withRequestContext(postHandler);
