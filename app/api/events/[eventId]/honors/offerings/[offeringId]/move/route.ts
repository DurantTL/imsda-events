import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { honorApiError } from "@/modules/honors/api-errors";
import { requireHonorPermission } from "@/modules/honors/access";
import { moveHonorOffering } from "@/modules/honors/schedule-repository";
import { honorMoveSchema } from "@/modules/honors/schedule-schemas";
import { withRequestContext } from "@/lib/request-context";

async function postHandler(request: Request, context: { params: Promise<{ eventId: string; offeringId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, offeringId } = await context.params;
    const access = await requireHonorPermission(eventId);
    const input = honorMoveSchema.parse(await request.json());
    return Response.json(await moveHonorOffering(eventId, offeringId, input, access.user.id));
  } catch (error) {
    return honorApiError(error, "Moving a class");
  }
}

export const POST = withRequestContext(postHandler);
