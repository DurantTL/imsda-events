import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireHealthViewerForClub } from "@/modules/health-records/access";
import { healthApiError, healthDisabledResponse, healthJson, readHealthJson } from "@/modules/health-records/api";
import { saveHealthRecord, viewHealthRecord } from "@/modules/health-records/repository";

type RouteContext = { params: Promise<{ organizationId: string; memberId: string }> };

/** Opens a member's Health tab for the club's director or deputy. The view is audited. */
async function getHandler(_request: Request, context: RouteContext) {
  const disabled = healthDisabledResponse();
  if (disabled) return disabled;
  try {
    const { organizationId, memberId } = await context.params;
    const viewer = await requireHealthViewerForClub(organizationId);
    return healthJson({ health: await viewHealthRecord(viewer, organizationId, memberId) });
  } catch (error) {
    return healthApiError(error, "Opening a health record");
  }
}

/** Director entry from the paper form, or a correction. Replaces the whole record. */
async function putHandler(request: Request, context: RouteContext) {
  const disabled = healthDisabledResponse();
  if (disabled) return disabled;
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, memberId } = await context.params;
    const viewer = await requireHealthViewerForClub(organizationId);
    const result = await saveHealthRecord(viewer, organizationId, memberId, await readHealthJson(request));
    return healthJson({ ok: true, status: result.status });
  } catch (error) {
    return healthApiError(error, "Saving a health record");
  }
}

export const GET = withRequestContext(getHandler);
export const PUT = withRequestContext(putHandler);
