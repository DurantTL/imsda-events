import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { ImportOperationError, listImportExceptions } from "@/modules/imports/repository";
import { findActiveMembership } from "@/modules/events/repository";
import { toCsv } from "@/modules/reporting/csv";

export async function GET(_request: Request, context: { params: Promise<{ eventId: string; importRunId: string }> }) {
  try {
    const { eventId, importRunId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "MANAGE_IMPORTS", findActiveMembership);
    const exceptions = await listImportExceptions(eventId, importRunId);
    const rows: Array<Array<string | number>> = [["Source row", "Source ID", "Confirmation code", "Proposed action", "Errors", "Warnings"]];
    for (const row of exceptions) rows.push([row.sourceRow, row.sourceRecordKey, row.confirmationCode, row.action, row.errors, row.warnings]);
    return new Response(toCsv(rows), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${importRunId}-exceptions.csv"`, "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    if (error instanceof ImportOperationError) return Response.json({ error: error.code, message: error.message }, { status: 404 });
    console.error("Exception export failed", error);
    return Response.json({ error: "EXCEPTION_EXPORT_FAILED", message: "The exception report could not be created." }, { status: 500 });
  }
}
