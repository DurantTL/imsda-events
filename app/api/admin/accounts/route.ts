import { requireSystemAdministrator } from "@/modules/organizations/access";
import { listAttendeeAccounts } from "@/modules/system-admin/user-admin";
import { userAdminApiError } from "@/modules/system-admin/user-admin-api";
import { withRequestContext } from "@/lib/request-context";

/** Attendee accounts for system administrators (#386), newest first, searchable by email or name. */
async function getHandler(request: Request) {
  try {
    await requireSystemAdministrator();
    const query = new URL(request.url).searchParams.get("q") ?? "";
    return Response.json({ accounts: await listAttendeeAccounts(query) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return userAdminApiError(error, "Loading accounts");
  }
}

export const GET = withRequestContext(getHandler);
