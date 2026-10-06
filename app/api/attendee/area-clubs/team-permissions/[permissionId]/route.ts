import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubTeamApiError } from "@/modules/club-teams/api-errors";
import { permissionDecisionSchema } from "@/modules/club-teams/permission-domain";
import { decideTeamPermission } from "@/modules/club-teams/permission-repository";
import { currentAreaCoordinator } from "@/modules/organizations/area-coordinators";
import { withRequestContext } from "@/lib/request-context";

/**
 * An Area Coordinator grants or declines a team member's permission (#809), only for teams registered at a location they
 * are the coordinator of, while their grant is active. Anyone else gets the same "not found" as a missing request.
 */
async function putHandler(request: Request, context: { params: Promise<{ permissionId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const account = await currentAreaCoordinator();
    if (!account) return Response.json({ message: "Not found." }, { status: 404, headers: { "Cache-Control": "private, no-store" } });
    const { permissionId } = await context.params;
    const { decision } = permissionDecisionSchema.parse(await request.json());
    const row = await decideTeamPermission({ permissionId, decision, actor: { accountId: account.id }, scope: { coordinatorAccountId: account.id } });
    return Response.json({ permission: row }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return clubTeamApiError(error, "Deciding the permission");
  }
}

export const PUT = withRequestContext(putHandler);
