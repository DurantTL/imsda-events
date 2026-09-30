import { clubReportApiError } from "@/modules/club-reports/api-errors";
import { areaExportResponse } from "@/modules/club-reports/area-export";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { withRequestContext } from "@/lib/request-context";

/** The same cross-club summary and points CSV for the conference office (#657). */
async function getHandler(request: Request) {
  try {
    await requireSystemAdministrator();
    return await areaExportResponse(new URL(request.url));
  } catch (error) {
    return clubReportApiError(error, "Exporting the club summary");
  }
}

export const GET = withRequestContext(getHandler);
