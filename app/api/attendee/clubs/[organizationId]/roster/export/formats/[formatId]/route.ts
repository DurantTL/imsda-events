import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { actorAttribution, requireRosterAccess } from "@/modules/club-rosters/access";
import { rosterApiError } from "@/modules/club-rosters/api-errors";
import { deleteRosterExportFormat, listRosterExportFormats } from "@/modules/club-rosters/export-repository";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ organizationId: string; formatId: string }> };

async function deleteHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, formatId } = await context.params;
    const access = await requireRosterAccess(organizationId);
    await deleteRosterExportFormat(organizationId, formatId, actorAttribution(access.actor));
    return Response.json({ formats: await listRosterExportFormats(organizationId) });
  } catch (error) {
    return rosterApiError(error, "Deleting a saved export format");
  }
}

export const DELETE = withRequestContext(deleteHandler);
