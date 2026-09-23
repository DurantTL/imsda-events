import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { honorApiError } from "@/modules/honors/api-errors";
import { requireHonorPermission } from "@/modules/honors/access";
import { updateHonorOffering } from "@/modules/honors/repository";
import { honorOfferingUpdateSchema } from "@/modules/honors/schemas";
import { withRequestContext } from "@/lib/request-context";

async function patchHandler(
  request: Request,
  context: { params: Promise<{ eventId: string; offeringId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, offeringId } = await context.params;
    const access = await requireHonorPermission(eventId);
    const input = honorOfferingUpdateSchema.parse(await request.json());
    return Response.json(await updateHonorOffering(eventId, offeringId, input, access.user.id));
  } catch (error) {
    return honorApiError(error, "Updating an honor offering");
  }
}

export const PATCH = withRequestContext(patchHandler);
