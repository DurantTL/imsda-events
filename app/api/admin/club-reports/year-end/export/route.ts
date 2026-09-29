import { clubReportApiError } from "@/modules/club-reports/api-errors";
import { yearEndReportCsv } from "@/modules/club-reports/year-end-csv";
import { isReportYear, latestStartedReportYear } from "@/modules/club-reports/year-end-domain";
import { listYearEndReportsForYear } from "@/modules/club-reports/year-end-repository";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { withRequestContext } from "@/lib/request-context";

/** Every club's Year-End Report for a Pathfinder year, one row per club, as CSV (#607). Counts only. */
async function getHandler(request: Request) {
  try {
    await requireSystemAdministrator();
    const requested = new URL(request.url).searchParams.get("year") ?? "";
    const reportYear = isReportYear(requested) ? requested : latestStartedReportYear(new Date());
    const csv = yearEndReportCsv(await listYearEndReportsForYear(reportYear));
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="year-end-reports-${reportYear}.csv"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return clubReportApiError(error, "Exporting year-end reports");
  }
}

export const GET = withRequestContext(getHandler);
