import { requireSystemAdministrator } from "@/modules/organizations/access";
import { parseAccountSort } from "@/modules/system-admin/account-sort";
import { listAttendeeAccounts } from "@/modules/system-admin/user-admin";
import { userAdminApiError } from "@/modules/system-admin/user-admin-api";
import { withRequestContext } from "@/lib/request-context";

/** Attendee accounts for system administrators (#386), newest first, searchable by email or name. */
async function getHandler(request: Request) {
  try {
    await requireSystemAdministrator();
    const params = new URL(request.url).searchParams;
    const query = params.get("q") ?? "";
    const sort = parseAccountSort(params.get("sort"), params.get("dir"));
    return Response.json({ accounts: await listAttendeeAccounts(query, sort) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return userAdminApiError(error, "Loading accounts");
  }
}

export const GET = withRequestContext(getHandler);
