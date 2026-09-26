import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { getCurrentSession } from "@/modules/access/current-session";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { ACT_AS_MINUTES, actAsAreaCoordinator } from "@/modules/organizations/staff-act-as";
import { userAdminApiError } from "@/modules/system-admin/user-admin-api";
import { withRequestContext } from "@/lib/request-context";

/** A system administrator acts as an Area Coordinator, inside their own staff session, for a while (#442). */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    // `requireSystemAdministrator` already required an authenticated staff
    // session; a `SYSTEM_ADMIN` session cannot exist without having
    // completed its second factor (mfa-rules.ts), so no further MFA check
    // is needed here.
    const { sessionId } = await getCurrentSession();
    if (!sessionId) throw new Error("A system administrator session is missing its session id.");
    await actAsAreaCoordinator(actor, sessionId);
    return Response.json({
      href: "/account/clubs",
      message: `You're acting as an Area Coordinator for the next ${ACT_AS_MINUTES / 60} hours, view only.`,
    });
  } catch (error) {
    return userAdminApiError(error, "Acting as an Area Coordinator");
  }
}

export const POST = withRequestContext(postHandler);
