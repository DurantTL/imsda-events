import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { lodgingApiError } from "@/modules/lodging/api-errors";
import { getLodgingView, setEventRate } from "@/modules/lodging/service";
import { withRequestContext } from "@/lib/request-context";

/** Setting a lodging rate changes what attendees pay, so it takes the finance permission, not just event setup. */
async function putHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_FINANCE", findActiveMembership);
    const result = await setEventRate(eventId, access.user.id, await request.json());
    return Response.json({ result, lodging: await getLodgingView(eventId) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return lodgingApiError(error, "Saving the lodging rate");
  }
}

export const PUT = withRequestContext(putHandler);
