import { getPrisma } from "@/lib/prisma";
import { withRequestContext } from "@/lib/request-context";
import { rosterYearView } from "@/modules/club-rosters/domain";
import { memberHonorApiError } from "@/modules/honors/member-honor-api-errors";
import { listActiveHonorOptions, listClubHonorsPage } from "@/modules/honors/member-honor-repository";
import { requireSystemAdministrator } from "@/modules/organizations/access";

type RouteContext = { params: Promise<{ organizationId: string }> };

/**
 * A club's current honors for staff, read only (#591): the list behind the
 * staff Honors screen. 404 unless the organization is a club (active or not),
 * like the staff page.
 */
async function getHandler(request: Request, context: RouteContext) {
  try {
    await requireSystemAdministrator();
    const { organizationId } = await context.params;
    const club = await getPrisma().organization.findUnique({
      where: { id: organizationId },
      select: { type: true },
    });
    if (!club || club.type !== "CLUB") {
      return Response.json({ error: "NOT_FOUND", message: "That club could not be found." }, { status: 404 });
    }
    // An optional ?year= (a listed club year only) lets the staff page reload the year it shows.
    const clubYear = rosterYearView(new URL(request.url).searchParams.get("year") ?? undefined).clubYear;
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
