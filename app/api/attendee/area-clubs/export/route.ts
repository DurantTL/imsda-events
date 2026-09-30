import { areaExportResponse } from "@/modules/club-reports/area-export";
import { currentAreaCoordinatorViewerActive } from "@/modules/organizations/area-coordinators";
import { withRequestContext } from "@/lib/request-context";

/** Cross-club summary or points CSV for an Area Coordinator (#657). Counts and points only. */
async function getHandler(request: Request) {
  if (!(await currentAreaCoordinatorViewerActive())) {
    return Response.json({ message: "Not found." }, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  }
  return areaExportResponse(new URL(request.url));
}

export const GET = withRequestContext(getHandler);
