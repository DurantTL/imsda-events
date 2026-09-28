import { withRequestContext } from "@/lib/request-context";
import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { earnedAwardApiError } from "@/modules/earned-awards/api-errors";
import { unlinkEventAwardItem } from "@/modules/earned-awards/event-items";
import { findActiveMembership } from "@/modules/events/repository";

/** Unlinks a catalog item from a club event (#532). CONFIGURE_EVENT; audited. Items already added for clubs stay. */
async function deleteHandler(request: Request, context: { params: Promise<{ eventId: string; itemId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, itemId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    return Response.json(await unlinkEventAwardItem(eventId, itemId, access.user.id));
  } catch (error) {
    return earnedAwardApiError(error, "Unlinking an event patch");
  }
}

export const DELETE = withRequestContext(deleteHandler);
