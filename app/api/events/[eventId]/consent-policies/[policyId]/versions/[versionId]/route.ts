import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { consentPolicyApiError } from "@/modules/consent/api-errors";
import { updateDraftPolicyVersion } from "@/modules/consent/repository";
import { findActiveMembership } from "@/modules/events/repository";
import { withRequestContext } from "@/lib/request-context";

/** Edits a draft version. Published versions are refused with 409. */
async function patchHandler(request: Request, context: { params: Promise<{ eventId: string; policyId: string; versionId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, policyId, versionId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    const version = await updateDraftPolicyVersion(eventId, policyId, versionId, access.user.id, await request.json());
    return Response.json({ version });
  } catch (error) { return consentPolicyApiError(error); }
}

export const PATCH = withRequestContext(patchHandler);
