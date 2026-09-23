import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireClubCapability } from "@/modules/club-rosters/access";
import { clubReportApiError } from "@/modules/club-reports/api-errors";
import { isReportMonth } from "@/modules/club-reports/domain";
import { saveClubReport } from "@/modules/club-reports/repository";
import { clubReportInputSchema } from "@/modules/club-reports/schemas";
import { withRequestContext } from "@/lib/request-context";

/** A director, deputy, or reporter submits or edits a monthly report (#377). */
async function putHandler(request: Request, context: { params: Promise<{ organizationId: string; month: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, month } = await context.params;
    const access = await requireClubCapability(organizationId, "submitReports");
    if (!isReportMonth(month)) return Response.json({ error: "CLUB_REPORT_MONTH_INVALID", message: "That month isn't valid." }, { status: 400 });
    const input = clubReportInputSchema.parse(await request.json());
    return Response.json({ report: await saveClubReport(organizationId, month, input, { accountId: access.accountId }) });
  } catch (error) {
    return clubReportApiError(error, "Saving the monthly report");
  }
}

export const PUT = withRequestContext(putHandler);
