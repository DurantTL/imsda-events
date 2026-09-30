import { withRequestContext } from "@/lib/request-context";
import { rosterYearView } from "@/modules/club-rosters/domain";
import { clubOrderApiError } from "@/modules/club-orders/api-errors";
import { requireClubSupplyAccess } from "@/modules/club-supplies/access";
import { classTrackingExportCsv, exportFileName } from "@/modules/reporting/director-exports";
import { auditDirectorExport, loadClassTrackingExport } from "@/modules/reporting/director-exports-repository";

type RouteContext = { params: Promise<{ organizationId: string }> };

/**
 * Class tracking export for a club director (#655): each active member's
 * class, insignia, event patches, Good Conduct/TLT items and Master Award
 * progress. Same gate as the Class tracking page (a registrar or Area
 * Coordinator reads). Names and item names only.
 */
async function getHandler(request: Request, context: RouteContext) {
  try {
    const { organizationId } = await context.params;
    const access = await requireClubSupplyAccess(organizationId);
    const { clubYear } = rosterYearView(new URL(request.url).searchParams.get("year") ?? undefined);
    const { clubName, rows } = await loadClassTrackingExport(organizationId, clubYear);
    await auditDirectorExport(
      organizationId, "class-tracking", clubYear, rows.length,
      access.mode === "EDIT" ? access.actor : access.viewer,
      access.mode === "READ",
    );
    return new Response(classTrackingExportCsv({ clubName, clubYear }, rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFileName("class-tracking", clubYear)}"`,
      },
    });
  } catch (error) {
    return clubOrderApiError(error, "Exporting class tracking");
  }
}

export const GET = withRequestContext(getHandler);
