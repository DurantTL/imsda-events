import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { lodgingApiError } from "@/modules/lodging/api-errors";
import { getLodgingView, selectEventProperty } from "@/modules/lodging/service";
import { withRequestContext } from "@/lib/request-context";

const noStore = { "Cache-Control": "no-store" };

async function getHandler(_request: Request, context: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    return Response.json({ lodging: await getLodgingView(eventId) }, { headers: noStore });
  } catch (error) {
    return lodgingApiError(error, "Loading lodging");
  }
}

async function postHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    const result = await selectEventProperty(eventId, access.user.id, await request.json());
    return Response.json({ result, lodging: await getLodgingView(eventId) }, { status: result.created ? 201 : 200, headers: noStore });
  } catch (error) {
    return lodgingApiError(error, "Choosing the lodging property");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
