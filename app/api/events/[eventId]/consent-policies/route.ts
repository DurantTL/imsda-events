import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { consentPolicyApiError } from "@/modules/consent/api-errors";
import { createConsentPolicy, listConsentPoliciesForEvent } from "@/modules/consent/repository";
import { findActiveMembership } from "@/modules/events/repository";
import { withRequestContext } from "@/lib/request-context";

async function getHandler(_request: Request, context: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    return Response.json({ policies: await listConsentPoliciesForEvent(eventId) });
  } catch (error) { return consentPolicyApiError(error); }
}

/** Creates an event-scoped policy with its first draft version. Organization
 * policies are never created through an event route. */
async function postHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    const policy = await createConsentPolicy(eventId, access.user.id, await request.json());
    return Response.json({ policy }, { status: 201 });
  } catch (error) { return consentPolicyApiError(error); }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
