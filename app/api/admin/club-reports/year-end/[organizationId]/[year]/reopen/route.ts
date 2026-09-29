import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubReportApiError } from "@/modules/club-reports/api-errors";
import { isReportYear } from "@/modules/club-reports/year-end-domain";
import { reopenYearEndReport } from "@/modules/club-reports/year-end-repository";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { withRequestContext } from "@/lib/request-context";

/** Conference staff reopen a submitted Year-End Report so the club can correct it (#607). */
async function postHandler(request: Request, context: { params: Promise<{ organizationId: string; year: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { organizationId, year } = await context.params;
    if (!isReportYear(year)) return Response.json({ error: "CLUB_REPORT_YEAR_INVALID", message: "That Pathfinder year isn't valid." }, { status: 400 });
    return Response.json({ report: await reopenYearEndReport(organizationId, year, actor.id) });
  } catch (error) {
    return clubReportApiError(error, "Reopening the year-end report");
  }
}

export const POST = withRequestContext(postHandler);
