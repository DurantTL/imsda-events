import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubImportApiError } from "@/modules/club-imports/api-errors";
import { MAX_IMPORT_BYTES, parseClubRegistrationExport } from "@/modules/club-imports/domain";
import { annotateImportDrafts } from "@/modules/club-imports/repository";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { withRequestContext } from "@/lib/request-context";

/**
 * Reads an uploaded form 89 export and returns an editable preview (#376).
 * The file is parsed in memory and never stored or logged.
 */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    await requireSystemAdministrator();
    const body = await request.text();
    if (body.length > MAX_IMPORT_BYTES) {
      return Response.json({ error: "EXPORT_TOO_LARGE", message: "That file is larger than 5 MB. Export fewer entries at a time." }, { status: 413 });
    }
    const { drafts, skipped } = parseClubRegistrationExport(JSON.parse(body));
    const annotated = await annotateImportDrafts(drafts);
    return Response.json({ ...annotated, skipped }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return clubImportApiError(error, "Reading the club export");
  }
}

export const POST = withRequestContext(postHandler);
