import { withRequestContext } from "@/lib/request-context";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { clubHonorsCsv } from "@/modules/honors/member-honor-domain";
import { requireHonorsAccess } from "@/modules/honors/member-honor-access";
import { memberHonorApiError } from "@/modules/honors/member-honor-api-errors";
import { auditClubHonorsExport, listClubHonorsPage } from "@/modules/honors/member-honor-repository";

type RouteContext = { params: Promise<{ organizationId: string }> };

/** Names and honors only (#486) — never birth dates, ages, or medical fields. */
async function getHandler(_request: Request, context: RouteContext) {
  try {
    const { organizationId } = await context.params;
    const access = await requireHonorsAccess(organizationId);
    const clubYear = clubYearFor(new Date());
    const rows = await listClubHonorsPage(organizationId, clubYear);
    await auditClubHonorsExport(
      organizationId,
      clubYear,
      rows.length,
      access.mode === "EDIT" ? access.actor : access.viewer,
      access.mode === "READ",
    );
    return new Response(clubHonorsCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="club-honors-${clubYear}.csv"`,
      },
    });
  } catch (error) {
    return memberHonorApiError(error, "Exporting club honors");
  }
}

export const GET = withRequestContext(getHandler);
