import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { actorAttribution, requireRosterAccess } from "@/modules/club-rosters/access";
import { rosterApiError } from "@/modules/club-rosters/api-errors";
import { isGuardianRosterExportColumn } from "@/modules/club-rosters/export-columns";
import { listRosterExportFormats, saveRosterExportFormat } from "@/modules/club-rosters/export-repository";
import { rosterExportFormatInputSchema } from "@/modules/club-rosters/export-schemas";
import { RosterAccessError } from "@/modules/club-rosters/access";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ organizationId: string }> };

async function getHandler(_request: Request, context: RouteContext) {
  try {
    const { organizationId } = await context.params;
    await requireRosterAccess(organizationId);
    return Response.json({ formats: await listRosterExportFormats(organizationId) });
  } catch (error) {
    return rosterApiError(error, "Loading saved export formats");
  }
}

async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId } = await context.params;
    const access = await requireRosterAccess(organizationId);
    const input = rosterExportFormatInputSchema.parse(await request.json());
    // A saved format never carries guardian columns for a role that may not see guardians (#510).
    if (!access.capabilities.guardians && input.columns.some((column) => isGuardianRosterExportColumn(column.key))) {
      throw new RosterAccessError("ROLE_NOT_ALLOWED", 403, "Guardian contacts are for your club's director and deputy.");
    }
    const format = await saveRosterExportFormat(organizationId, input, actorAttribution(access.actor));
    return Response.json({ format, formats: await listRosterExportFormats(organizationId) }, { status: 201 });
  } catch (error) {
    return rosterApiError(error, "Saving an export format");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
