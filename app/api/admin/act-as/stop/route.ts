import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { getCurrentSession } from "@/modules/access/current-session";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { stopActingAs, stopActingHref } from "@/modules/organizations/staff-act-as";
import { userAdminApiError } from "@/modules/system-admin/user-admin-api";
import { withRequestContext } from "@/lib/request-context";

/**
 * "Stop acting" for both act-as roles, from the staff session (#442). Returns
 * a safe staff `href` to land on (#466): the page the staff member was
 * acting from can belong to the attendee portal, which redirects to
 * attendee sign-in once the act-as is gone even though the staff session is
 * still signed in.
 */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { sessionId } = await getCurrentSession();
    if (!sessionId) throw new Error("A system administrator session is missing its session id.");
    const stopped = await stopActingAs(actor, sessionId);
    return Response.json({ ok: true, stopped: Boolean(stopped), href: stopActingHref(stopped) });
  } catch (error) {
    return userAdminApiError(error, "Stopping act-as");
  }
}

export const POST = withRequestContext(postHandler);
