import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { lodgingApiError } from "@/modules/lodging/api-errors";
import { getLodgingView, updateEventUnit } from "@/modules/lodging/service";
import { withRequestContext } from "@/lib/request-context";

async function patchHandler(request: Request, context: { params: Promise<{ eventId: string; unitId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, unitId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    const unit = await updateEventUnit(eventId, unitId, access.user.id, await request.json());
    return Response.json({ unit, lodging: await getLodgingView(eventId) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return lodgingApiError(error, "Updating the lodging unit");
  }
}

export const PATCH = withRequestContext(patchHandler);
