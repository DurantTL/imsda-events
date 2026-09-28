import { withRequestContext } from "@/lib/request-context";
import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { earnedAwardApiError } from "@/modules/earned-awards/api-errors";
import { linkEventAwardItem, listEventAwardItems } from "@/modules/earned-awards/event-items";
import { eventAwardItemSchema } from "@/modules/earned-awards/schemas";
import { findActiveMembership } from "@/modules/events/repository";

type RouteContext = { params: Promise<{ eventId: string }> };

/** The patches and pins linked to a club event (#532), and the catalog items that can be linked. CONFIGURE_EVENT. */
async function getHandler(_request: Request, context: RouteContext) {
  try {
    const { eventId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    return Response.json(await listEventAwardItems(eventId));
  } catch (error) {
    return earnedAwardApiError(error, "Loading event patches");
  }
}

/** Links a catalog item to a club event as its patch or pin (#532). CONFIGURE_EVENT; audited. */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    const { itemId } = eventAwardItemSchema.parse(await request.json());
    return Response.json(await linkEventAwardItem(eventId, itemId, access.user.id), { status: 201 });
  } catch (error) {
    return earnedAwardApiError(error, "Linking an event patch");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
