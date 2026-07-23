import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { messagingApiError } from "@/modules/communications/api-errors";
import { processPendingMessages } from "@/modules/communications/messaging-repository";
import { findActiveMembership } from "@/modules/events/repository";

export async function POST(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(
      await getCurrentSession(),
      eventId,
      "MANAGE_COMMUNICATIONS",
      findActiveMembership,
    );
    const messaging = await processPendingMessages(eventId, access.user.id);
    return Response.json({ messaging });
  } catch (error) {
    return messagingApiError(error, "Processing the message queue");
  }
}
