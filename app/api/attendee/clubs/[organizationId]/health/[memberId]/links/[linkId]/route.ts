import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireHealthViewerForClub } from "@/modules/health-records/access";
import { healthApiError, healthDisabledResponse, healthJson } from "@/modules/health-records/api";
import { revokeHealthRecordLink } from "@/modules/health-records/repository";

type RouteContext = { params: Promise<{ organizationId: string; memberId: string; linkId: string }> };

async function deleteHandler(request: Request, context: RouteContext) {
  const disabled = healthDisabledResponse();
  if (disabled) return disabled;
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, linkId } = await context.params;
    const viewer = await requireHealthViewerForClub(organizationId);
    await revokeHealthRecordLink(viewer, organizationId, linkId);
    return healthJson({ ok: true });
  } catch (error) {
    return healthApiError(error, "Withdrawing a health record link");
  }
}

export const DELETE = withRequestContext(deleteHandler);
