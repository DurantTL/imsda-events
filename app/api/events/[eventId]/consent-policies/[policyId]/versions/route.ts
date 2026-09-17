import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { consentPolicyApiError } from "@/modules/consent/api-errors";
import { createNextDraftVersion } from "@/modules/consent/repository";
import { findActiveMembership } from "@/modules/events/repository";
import { withRequestContext } from "@/lib/request-context";

async function postHandler(request: Request, context: { params: Promise<{ eventId: string; policyId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, policyId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    const version = await createNextDraftVersion(eventId, policyId, access.user.id, await request.json());
    return Response.json({ version }, { status: 201 });
  } catch (error) { return consentPolicyApiError(error); }
}

export const POST = withRequestContext(postHandler);
