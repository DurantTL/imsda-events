import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { getCurrentSession } from "@/modules/access/current-session";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { stopActingAs } from "@/modules/organizations/staff-act-as";
import { userAdminApiError } from "@/modules/system-admin/user-admin-api";
import { withRequestContext } from "@/lib/request-context";

/** "Stop acting" for both act-as roles, from the staff session (#442). */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { sessionId } = await getCurrentSession();
    if (!sessionId) throw new Error("A system administrator session is missing its session id.");
    const stopped = await stopActingAs(actor, sessionId);
    return Response.json({ ok: true, stopped: Boolean(stopped) });
  } catch (error) {
    return userAdminApiError(error, "Stopping act-as");
  }
}

export const POST = withRequestContext(postHandler);
