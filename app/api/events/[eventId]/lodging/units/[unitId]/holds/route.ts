import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { lodgingApiError } from "@/modules/lodging/api-errors";
import { createHold, getLodgingView } from "@/modules/lodging/service";
import { withRequestContext } from "@/lib/request-context";

async function postHandler(request: Request, context: { params: Promise<{ eventId: string; unitId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, unitId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    const hold = await createHold(eventId, unitId, access.user.id, await request.json());
    return Response.json({ hold, lodging: await getLodgingView(eventId) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return lodgingApiError(error, "Placing the hold");
  }
}

export const POST = withRequestContext(postHandler);
