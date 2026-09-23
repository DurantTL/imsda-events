import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { honorApiError } from "@/modules/honors/api-errors";
import { requireHonorPermission } from "@/modules/honors/access";
import { createHonorSession } from "@/modules/honors/repository";
import { honorSessionInputSchema } from "@/modules/honors/schemas";
import { withRequestContext } from "@/lib/request-context";

async function postHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requireHonorPermission(eventId);
    const input = honorSessionInputSchema.parse(await request.json());
    return Response.json(await createHonorSession(eventId, input, access.user.id), { status: 201 });
  } catch (error) {
    return honorApiError(error, "Adding a session");
  }
}

export const POST = withRequestContext(postHandler);
