import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { ACT_AS_MINUTES, actAsClubDirector } from "@/modules/organizations/area-coordinators";
import { userAdminApiError } from "@/modules/system-admin/user-admin-api";
import { withRequestContext } from "@/lib/request-context";

/** A system administrator acts as this club's Director, through their own account, for a while (#387). */
async function postHandler(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { organizationId } = await context.params;
    const result = await actAsClubDirector(actor, organizationId);
    return Response.json({
      href: `/account/clubs/${organizationId}`,
      message: result.alreadyHadRole
        ? "You're already this club's Director on your own account."
        : `You're this club's Director on your own account for the next ${ACT_AS_MINUTES / 60} hours.`,
    });
  } catch (error) {
    return userAdminApiError(error, "Acting as a club director");
  }
}

export const POST = withRequestContext(postHandler);
