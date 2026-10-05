import { kitchenReportCsv } from "@/modules/registrations/kitchen-report";
import { loadAreaKitchenReport } from "@/modules/registrations/kitchen-report-loader";
import { kitchenCsvResponse } from "@/modules/registrations/kitchen-report-response";
import { withRequestContext } from "@/lib/request-context";

/** The kitchen report CSV for an Area Coordinator (#787). Not found for anyone else, before any data is read. */
async function getHandler(_request: Request, context: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await context.params;
  const result = await loadAreaKitchenReport(eventId);
  if (!result) return Response.json({ message: "Not found." }, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  return kitchenCsvResponse(kitchenReportCsv(result.report), eventId);
}

export const GET = withRequestContext(getHandler);
