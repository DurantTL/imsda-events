import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireHealthViewerForClub } from "@/modules/health-records/access";
import { healthApiError, healthDisabledResponse, healthJson } from "@/modules/health-records/api";
import { confirmHealthRecord } from "@/modules/health-records/repository";

type RouteContext = { params: Promise<{ organizationId: string; memberId: string }> };

/** The director confirms an existing record is still right for this club year. */
async function postHandler(request: Request, context: RouteContext) {
  const disabled = healthDisabledResponse();
  if (disabled) return disabled;
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, memberId } = await context.params;
    const viewer = await requireHealthViewerForClub(organizationId);
    const result = await confirmHealthRecord(viewer, organizationId, memberId);
    return healthJson({ ok: true, status: result.status });
  } catch (error) {
    return healthApiError(error, "Confirming a health record");
  }
}

export const POST = withRequestContext(postHandler);
