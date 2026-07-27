import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { CsvImportError, previewCsvImport, previewWr26BundleImport } from "@/modules/imports/repository";
import { findActiveMembership } from "@/modules/events/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;

async function postHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_IMPORTS", findActiveMembership);
    const formData = await request.formData();
    const bundleFiles = formData.getAll("files").filter((value): value is File => value instanceof File);
    const legacyFile = formData.get("file");
    const files = bundleFiles.length > 0
      ? bundleFiles
      : legacyFile instanceof File
        ? [legacyFile]
        : [];
    if (files.length === 0) return Response.json({ error: "CSV_REQUIRED", message: "Choose one or more CSV files to preview." }, { status: 400 });
    if (files.some((file) => !file.name.toLowerCase().endsWith(".csv"))) {
      return Response.json({ error: "CSV_REQUIRED", message: "Every import file must use the .csv extension." }, { status: 400 });
    }
    if (files.some((file) => file.size > MAX_FILE_BYTES) || files.reduce((total, file) => total + file.size, 0) > MAX_BUNDLE_BYTES) {
      return Response.json({ error: "CSV_TOO_LARGE", message: "Each CSV must be 2 MB or smaller and the complete bundle must be 10 MB or smaller." }, { status: 413 });
    }
    const result = files.length === 1
      ? await previewCsvImport(eventId, access.user.id, files[0].name.slice(0, 180), await files[0].text())
      : await previewWr26BundleImport(
          eventId,
          access.user.id,
          await Promise.all(files.map(async (file) => ({
            name: file.name.slice(0, 180),
            text: await file.text(),
          }))),
        );
    return Response.json(result, { status: result.reused ? 200 : 201 });
  } catch (error) {
    if (error instanceof CsvImportError) return Response.json({ error: error.code, message: error.message }, { status: 400 });
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    logError("Import preview failed", error);
    return Response.json({ error: "IMPORT_PREVIEW_FAILED", message: "The CSV preview could not be created." }, { status: 500 });
  }
}

export const POST = withRequestContext(postHandler);
