import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { CsvImportError, previewCsvImport } from "@/modules/imports/repository";
import { findActiveMembership } from "@/modules/events/repository";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export async function POST(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_IMPORTS", findActiveMembership);
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) return Response.json({ error: "CSV_REQUIRED", message: "Choose a CSV file to preview." }, { status: 400 });
    if (!file.name.toLowerCase().endsWith(".csv")) return Response.json({ error: "CSV_REQUIRED", message: "The import file must use the .csv extension." }, { status: 400 });
    if (file.size > MAX_FILE_BYTES) return Response.json({ error: "CSV_TOO_LARGE", message: "CSV files must be 2 MB or smaller." }, { status: 413 });
    const result = await previewCsvImport(eventId, access.user.id, file.name.slice(0, 180), await file.text());
    return Response.json(result, { status: result.reused ? 200 : 201 });
  } catch (error) {
    if (error instanceof CsvImportError) return Response.json({ error: error.code, message: error.message }, { status: 400 });
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    console.error("Import preview failed", error);
    return Response.json({ error: "IMPORT_PREVIEW_FAILED", message: "The CSV preview could not be created." }, { status: 500 });
  }
}
