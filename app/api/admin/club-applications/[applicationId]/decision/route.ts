import { AccessDeniedError } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { withRequestContext } from "@/lib/request-context";
import { newClubApplicationApiError } from "@/modules/club-applications/api-errors";
import { newClubDecisionSchema } from "@/modules/club-applications/domain";
import { decideNewClubApplication } from "@/modules/club-applications/repository";
import { currentApplicationViewer } from "@/modules/club-applications/viewer";

/**
 * Approve or decline a new club application (#817). System administrators
 * only: an Area Coordinator, who may read the queue, gets 403 here, and
 * anyone signed out gets 401. Authorized before the body is read.
 */
type RouteContext = { params: Promise<{ applicationId: string }> };

async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { applicationId } = await context.params;
    const { user } = await getCurrentSession();
    if (!user) {
      const viewer = await currentApplicationViewer();
      if (viewer) throw new AccessDeniedError("Only a system administrator can approve or decline a new club application.", 403, "PERMISSION_DENIED");
      throw new AccessDeniedError("Authentication is required.", 401, "AUTHENTICATION_REQUIRED");
    }
    if (user.globalRole !== "SYSTEM_ADMIN") {
      throw new AccessDeniedError("Only a system administrator can approve or decline a new club application.", 403, "PERMISSION_DENIED");
    }
    const decision = newClubDecisionSchema.parse(await request.json().catch(() => ({})));
    const result = await decideNewClubApplication(user, applicationId, decision);
    return Response.json({ id: applicationId, status: result.status, organizationId: result.organizationId });
  } catch (error) {
    return newClubApplicationApiError(error, "Deciding a new club application");
  }
}

export const POST = withRequestContext(postHandler);
