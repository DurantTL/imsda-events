import { clubReportApiError } from "@/modules/club-reports/api-errors";
import { clubYearReportCsv } from "@/modules/club-reports/csv";
import { listClubReportsForYear } from "@/modules/club-reports/repository";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { withRequestContext } from "@/lib/request-context";

/** Every club's monthly points for a club year, as CSV (#377). */
async function getHandler(request: Request) {
  try {
    await requireSystemAdministrator();
    const requested = new URL(request.url).searchParams.get("year") ?? "";
    const clubYear = /^\d{4}-\d{2}$/.test(requested) ? requested : clubYearFor(new Date());
    const csv = clubYearReportCsv(clubYear, await listClubReportsForYear(clubYear), new Date());
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="club-reports-${clubYear}.csv"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return clubReportApiError(error, "Exporting club reports");
  }
}

export const GET = withRequestContext(getHandler);
