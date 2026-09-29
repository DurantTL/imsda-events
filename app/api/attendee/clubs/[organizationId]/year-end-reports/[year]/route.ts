import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { actorAttribution, requireClubCapability } from "@/modules/club-rosters/access";
import { clubReportApiError } from "@/modules/club-reports/api-errors";
import { isReportYear } from "@/modules/club-reports/year-end-domain";
import { saveYearEndReport } from "@/modules/club-reports/year-end-repository";
import { yearEndReportInputSchema } from "@/modules/club-reports/year-end-schemas";
import { withRequestContext } from "@/lib/request-context";

/** A director, deputy, or reporter saves or submits the Pathfinder Year-End Report (#607). A registrar can't. */
async function putHandler(request: Request, context: { params: Promise<{ organizationId: string; year: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, year } = await context.params;
    const access = await requireClubCapability(organizationId, "submitReports");
    if (!isReportYear(year)) return Response.json({ error: "CLUB_REPORT_YEAR_INVALID", message: "That Pathfinder year isn't valid." }, { status: 400 });
    const input = yearEndReportInputSchema.parse(await request.json());
    return Response.json({ report: await saveYearEndReport(organizationId, year, input, actorAttribution(access.actor)) });
  } catch (error) {
    return clubReportApiError(error, "Saving the year-end report");
  }
}

export const PUT = withRequestContext(putHandler);
