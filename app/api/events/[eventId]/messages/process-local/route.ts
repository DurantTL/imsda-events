import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { messagingApiError } from "@/modules/communications/api-errors";
import { processPendingMessagesLocally } from "@/modules/communications/messaging-repository";
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
    const messaging = await processPendingMessagesLocally(eventId, access.user.id);
    return Response.json({ messaging });
  } catch (error) {
    return messagingApiError(error, "Processing the local message queue");
  }
}
