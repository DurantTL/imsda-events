import { withRequestContext } from "@/lib/request-context";
import { clubSupplyApiError } from "@/modules/club-supplies/api-errors";
import { listClubSupplyItems } from "@/modules/club-supplies/repository";
import { requireSystemAdministrator } from "@/modules/organizations/access";

/** The club supply catalog (#531), system administrators only. */
async function getHandler() {
  try {
    await requireSystemAdministrator();
    return Response.json({ items: await listClubSupplyItems() });
  } catch (error) {
    return clubSupplyApiError(error, "Loading the club supply catalog");
  }
}

export const GET = withRequestContext(getHandler);
