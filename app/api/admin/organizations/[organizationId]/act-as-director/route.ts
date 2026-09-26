import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { getCurrentSession } from "@/modules/access/current-session";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { ACT_AS_MINUTES, actAsClubDirector } from "@/modules/organizations/staff-act-as";
import { userAdminApiError } from "@/modules/system-admin/user-admin-api";
import { withRequestContext } from "@/lib/request-context";

/** A system administrator acts as this club's Director, inside their own staff session, for a while (#442). */
async function postHandler(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { sessionId } = await getCurrentSession();
    if (!sessionId) throw new Error("A system administrator session is missing its session id.");
    const { organizationId } = await context.params;
    const result = await actAsClubDirector(actor, sessionId, organizationId);
    return Response.json({
      href: `/account/clubs/${organizationId}`,
      message: `You're acting as director of ${result.clubName} for the next ${ACT_AS_MINUTES / 60} hours.`,
    });
  } catch (error) {
    return userAdminApiError(error, "Acting as a club director");
  }
}

export const POST = withRequestContext(postHandler);
