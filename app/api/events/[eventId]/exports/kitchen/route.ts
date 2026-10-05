import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { findActiveMembership } from "@/modules/events/repository";
import { kitchenReportCsv } from "@/modules/registrations/kitchen-report";
import { loadKitchenReport } from "@/modules/registrations/kitchen-report-loader";
import { kitchenCsvResponse } from "@/modules/registrations/kitchen-report-response";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

/** The kitchen report as CSV (#787). VIEW_REPORTS is enough: counts and anonymous answers only. */
async function getHandler(_request: Request, context: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "VIEW_REPORTS", findActiveMembership);
    return kitchenCsvResponse(kitchenReportCsv(await loadKitchenReport(eventId)), eventId);
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    logError("Unable to export kitchen report", error);
    return Response.json({ error: "KITCHEN_REPORT_EXPORT_FAILED" }, { status: 500 });
  }
}

export const GET = withRequestContext(getHandler);
