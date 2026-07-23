import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { getImportRun } from "@/modules/imports/repository";
import { findActiveMembership } from "@/modules/events/repository";

export async function GET(_request: Request, context: { params: Promise<{ eventId: string; importRunId: string }> }) {
  try {
    const { eventId, importRunId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "MANAGE_IMPORTS", findActiveMembership);
    const run = await getImportRun(eventId, importRunId);
    return run ? Response.json({ run }) : Response.json({ error: "IMPORT_NOT_FOUND", message: "That import run was not found." }, { status: 404 });
  } catch (error) {
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    console.error("Import detail request failed", error);
    return Response.json({ error: "IMPORT_DETAIL_FAILED", message: "The import run could not be loaded." }, { status: 500 });
  }
}
