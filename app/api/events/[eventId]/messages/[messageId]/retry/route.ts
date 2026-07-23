import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { messagingApiError } from "@/modules/communications/api-errors";
import {
  getMessagingWorkspace,
  retryMessage,
} from "@/modules/communications/messaging-repository";
import { messageRetryInputSchema } from "@/modules/communications/schemas";
import { findActiveMembership } from "@/modules/events/repository";

export async function POST(
  request: Request,
  context: { params: Promise<{ eventId: string; messageId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, messageId } = await context.params;
    const access = await requirePermission(
      await getCurrentSession(),
      eventId,
      "MANAGE_COMMUNICATIONS",
      findActiveMembership,
    );
    const input = messageRetryInputSchema.parse(await request.json());
    const operation = await retryMessage(
      eventId,
      messageId,
      input,
      access.user.id,
    );
    const messaging = await getMessagingWorkspace(eventId);
    return Response.json({ operation, messaging }, { status: 201 });
  } catch (error) {
    return messagingApiError(error, "Retrying the message");
  }
}
