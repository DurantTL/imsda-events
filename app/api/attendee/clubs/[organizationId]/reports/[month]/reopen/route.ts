import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireClubCapability } from "@/modules/club-rosters/access";
import { clubReportApiError } from "@/modules/club-reports/api-errors";
import { isReportMonth } from "@/modules/club-reports/domain";
import { reopenClubReport } from "@/modules/club-reports/repository";
import { withRequestContext } from "@/lib/request-context";

/** A director, deputy, or reporter reopens their own submitted report back to a draft (#426). */
async function postHandler(request: Request, context: { params: Promise<{ organizationId: string; month: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, month } = await context.params;
    const access = await requireClubCapability(organizationId, "submitReports");
    if (!isReportMonth(month)) return Response.json({ error: "CLUB_REPORT_MONTH_INVALID", message: "That month isn't valid." }, { status: 400 });
    return Response.json({ report: await reopenClubReport(organizationId, month, access.accountId) });
  } catch (error) {
    return clubReportApiError(error, "Reopening the monthly report");
  }
}

export const POST = withRequestContext(postHandler);
