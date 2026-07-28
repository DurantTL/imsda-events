import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { messagingApiError } from "@/modules/communications/api-errors";
import {
  enqueueShirtSizeRequestBatch,
  getShirtSizeRequestPreview,
  getMessagingWorkspace,
} from "@/modules/communications/messaging-repository";
import { shirtSizeRequestBatchInputSchema } from "@/modules/communications/schemas";
import { findActiveMembership } from "@/modules/events/repository";
import { withRequestContext } from "@/lib/request-context";

async function authorize(eventId: string) {
  return requirePermission(
    await getCurrentSession(),
    eventId,
    "MANAGE_COMMUNICATIONS",
    findActiveMembership,
  );
}

async function getHandler(
  _request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  try {
    const { eventId } = await context.params;
    await authorize(eventId);
    const shirtSizePreview = await getShirtSizeRequestPreview(eventId);
    return Response.json({ shirtSizePreview });
  } catch (error) {
    return messagingApiError(error, "Refreshing the shirt-size request preview");
  }
}

async function postHandler(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await authorize(eventId);
    const input = shirtSizeRequestBatchInputSchema.parse(await request.json());
    const operation = await enqueueShirtSizeRequestBatch(
      eventId,
      input,
      access.user.id,
    );
    const messaging = await getMessagingWorkspace(eventId);
    return Response.json({ operation, messaging }, { status: 201 });
  } catch (error) {
    return messagingApiError(error, "Creating the shirt-size request batch");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
