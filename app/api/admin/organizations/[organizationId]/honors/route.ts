import { withRequestContext } from "@/lib/request-context";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { memberHonorApiError } from "@/modules/honors/member-honor-api-errors";
import { listActiveHonorOptions, listClubHonorsPage } from "@/modules/honors/member-honor-repository";
import { requireSystemAdministrator } from "@/modules/organizations/access";

type RouteContext = { params: Promise<{ organizationId: string }> };

/** A club's current honors for staff, read only (#591): the list behind the staff Honors screen. */
async function getHandler(_request: Request, context: RouteContext) {
  try {
    await requireSystemAdministrator();
    const { organizationId } = await context.params;
    const clubYear = clubYearFor(new Date());
    const [rows, honors] = await Promise.all([
      listClubHonorsPage(organizationId, clubYear),
      listActiveHonorOptions(),
    ]);
    return Response.json({ clubYear, rows, honors, readOnly: true });
  } catch (error) {
    return memberHonorApiError(error, "Loading club honors");
  }
}

export const GET = withRequestContext(getHandler);
