import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { messagingApiError } from "@/modules/communications/api-errors";
import { getMessagingWorkspace } from "@/modules/communications/messaging-repository";
import { findActiveMembership } from "@/modules/events/repository";
import { withRequestContext } from "@/lib/request-context";

/** The delivery log and counts, for the workspace's light refresh while messages are queued or sending (#860). */
async function getHandler(
  _request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  try {
    const { eventId } = await context.params;
    await requirePermission(
      await getCurrentSession(),
      eventId,
      "MANAGE_COMMUNICATIONS",
      findActiveMembership,
    );
    const messaging = await getMessagingWorkspace(eventId);
    return Response.json({ messaging }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return messagingApiError(error, "Refreshing the delivery log");
  }
}

export const GET = withRequestContext(getHandler);
