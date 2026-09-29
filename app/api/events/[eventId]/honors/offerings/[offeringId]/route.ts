import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { honorApiError } from "@/modules/honors/api-errors";
import { requireHonorPermission } from "@/modules/honors/access";
import { deleteHonorOffering, updateHonorOffering } from "@/modules/honors/repository";
import { honorOfferingUpdateSchema, parseDeleteConfirmation } from "@/modules/honors/schemas";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ eventId: string; offeringId: string }> };

async function patchHandler(request: Request, context: RouteContext) {
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

async function deleteHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, offeringId } = await context.params;
    const access = await requireHonorPermission(eventId);
    const confirmPicks = parseDeleteConfirmation(request);
    return Response.json(await deleteHonorOffering(eventId, offeringId, access.user.id, confirmPicks));
  } catch (error) {
    return honorApiError(error, "Removing an honor offering");
  }
}

export const PATCH = withRequestContext(patchHandler);
export const DELETE = withRequestContext(deleteHandler);
