import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { lodgingApiError } from "@/modules/lodging/api-errors";
import { applyAssignmentPlan, previewAssignmentPlan } from "@/modules/lodging/assignment-service";
import { getAssignmentWorkspace } from "@/modules/lodging/assignment-view";
import { requireLodgingStaff } from "@/modules/lodging/staff-access";
import { withRequestContext } from "@/lib/request-context";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };

/**
 * The rule-assisted proposal and the CSV import, preview first (#200). `mode: "preview"` changes nothing and returns
 * what would happen row by row with a fingerprint. `mode: "apply"` needs that fingerprint and applies only if the plan
 * rebuilt under the locks is exactly the one previewed. A proposal is never applied by itself. MANAGE_REGISTRATION;
 * the proposal reads accessibility needs only for staff with VIEW_SENSITIVE_DATA.
 */
async function postHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const staff = await requireLodgingStaff(eventId, "MANAGE_REGISTRATION");
    const body = await request.json();
    if ((body as { mode?: unknown } | null)?.mode === "apply") {
      const result = await applyAssignmentPlan(eventId, staff.userId, body, { canSeeSensitive: staff.canSeeSensitive });
      return Response.json({ result, workspace: await getAssignmentWorkspace(eventId, { canSeeSensitive: staff.canSeeSensitive }) }, { headers: noStore });
    }
    return Response.json({ preview: await previewAssignmentPlan(eventId, body, { canSeeSensitive: staff.canSeeSensitive }) }, { headers: noStore });
  } catch (error) {
    return lodgingApiError(error, "Planning lodging assignments");
  }
}

export const POST = withRequestContext(postHandler);
