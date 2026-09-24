import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubReportApiError } from "@/modules/club-reports/api-errors";
import { isReportMonth } from "@/modules/club-reports/domain";
import { saveClubReport } from "@/modules/club-reports/repository";
import { clubReportInputSchema } from "@/modules/club-reports/schemas";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { withRequestContext } from "@/lib/request-context";

/** Conference staff file or correct a club's report at any time (#377). */
async function putHandler(request: Request, context: { params: Promise<{ organizationId: string; month: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { organizationId, month } = await context.params;
    if (!isReportMonth(month)) return Response.json({ error: "CLUB_REPORT_MONTH_INVALID", message: "That month isn't valid." }, { status: 400 });
    // Staff files or corrects directly; there's no staff-side draft (#426).
    const input = clubReportInputSchema.parse({ ...(await request.json()), status: "SUBMITTED" });
    return Response.json({ report: await saveClubReport(organizationId, month, input, { userId: actor.id }) });
  } catch (error) {
    return clubReportApiError(error, "Saving a club's monthly report");
  }
}

export const PUT = withRequestContext(putHandler);
