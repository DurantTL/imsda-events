import { withRequestContext } from "@/lib/request-context";
import { rosterYearView } from "@/modules/club-rosters/domain";
import { honorCategoryLabels } from "@/modules/honors/domain";
import { requireHonorsAccess } from "@/modules/honors/member-honor-access";
import { memberHonorApiError } from "@/modules/honors/member-honor-api-errors";
import { honorsExportCsv, exportFileName } from "@/modules/reporting/director-exports";
import { auditDirectorExport, loadHonorsExport } from "@/modules/reporting/director-exports-repository";

type RouteContext = { params: Promise<{ organizationId: string }> };

/**
 * Honors export for a club director (#655): CSV with the club name and year,
 * one row per member and honor, and a count-per-honor summary. Same gate as
 * the Honors page (a registrar or Area Coordinator reads). Filters: `year`,
 * `member` (roster member id), `category`. Names and honors only.
 */
async function getHandler(request: Request, context: RouteContext) {
  try {
    const { organizationId } = await context.params;
    const access = await requireHonorsAccess(organizationId);
    const params = new URL(request.url).searchParams;
    const { clubYear } = rosterYearView(params.get("year") ?? undefined);
    const category = params.get("category") ?? "";
    const { clubName, rows } = await loadHonorsExport(organizationId, clubYear, {
      memberId: params.get("member") || undefined,
      category: category in honorCategoryLabels ? category : undefined,
    });
    await auditDirectorExport(
      organizationId, "honors", clubYear, rows.length,
      access.mode === "EDIT" ? access.actor : access.viewer,
      access.mode === "READ",
    );
    return new Response(honorsExportCsv({ clubName, clubYear }, rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFileName("honors", clubYear)}"`,
      },
    });
  } catch (error) {
    return memberHonorApiError(error, "Exporting club honors");
  }
}

export const GET = withRequestContext(getHandler);
