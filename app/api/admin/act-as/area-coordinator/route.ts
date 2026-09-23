import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { ACT_AS_MINUTES, actAsAreaCoordinator } from "@/modules/organizations/area-coordinators";
import { userAdminApiError } from "@/modules/system-admin/user-admin-api";
import { withRequestContext } from "@/lib/request-context";

/** A system administrator acts as an Area Coordinator, through their own account, for a while (#387). */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { expiresAt } = await actAsAreaCoordinator(actor);
    return Response.json({
      href: "/account/clubs",
      message: expiresAt
        ? `You're an Area Coordinator on your own account for the next ${ACT_AS_MINUTES / 60} hours.`
        : "Your own account is already an Area Coordinator.",
    });
  } catch (error) {
    return userAdminApiError(error, "Acting as an Area Coordinator");
  }
}

export const POST = withRequestContext(postHandler);
