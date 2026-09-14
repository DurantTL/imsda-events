import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { CsvImportError, previewWr26BundleImport } from "@/modules/imports/repository";
import { fetchWr26BundleFromGoogleSheet } from "@/modules/imports/google-sheets";
import { findActiveMembership } from "@/modules/events/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

async function postHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_IMPORTS", findActiveMembership);
    const body = await request.json().catch(() => null);
    const url = typeof body?.url === "string" ? body.url.trim() : "";
    if (!url) return Response.json({ error: "SHEET_URL_REQUIRED", message: "Paste the Google Sheet link first." }, { status: 400 });
    const files = await fetchWr26BundleFromGoogleSheet(url);
    const result = await previewWr26BundleImport(eventId, access.user.id, files);
    return Response.json(result, { status: result.reused ? 200 : 201 });
  } catch (error) {
    if (error instanceof CsvImportError) return Response.json({ error: error.code, message: error.message }, { status: 400 });
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    logError("Google Sheet import preview failed", error);
    return Response.json(
      { error: "SHEET_IMPORT_FAILED", message: "The Google Sheet could not be read. Confirm sharing is set to \"Anyone with the link can view\" and try again." },
      { status: 502 },
    );
  }
}

export const POST = withRequestContext(postHandler);
