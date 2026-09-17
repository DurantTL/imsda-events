import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { consentPolicyApiError } from "@/modules/consent/api-errors";
import { updateEventPolicyApplicability } from "@/modules/consent/repository";
import { findActiveMembership } from "@/modules/events/repository";
import { withRequestContext } from "@/lib/request-context";

async function patchHandler(request: Request, context: { params: Promise<{ eventId: string; applicabilityId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, applicabilityId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    const applicability = await updateEventPolicyApplicability(eventId, applicabilityId, access.user.id, await request.json());
    return Response.json({ applicability });
  } catch (error) { return consentPolicyApiError(error); }
}

export const PATCH = withRequestContext(patchHandler);
