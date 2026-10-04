import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { reconciliationCsvRows } from "@/modules/attendance-reconciliation/domain";
import { AttendanceReconciliationError, getAttendanceReconciliationExport } from "@/modules/attendance-reconciliation/repository";
import { findActiveMembership } from "@/modules/events/repository";
import { locationParam, resolveLocationFilter } from "@/modules/event-locations/filter";
import { toCsv } from "@/modules/reporting/csv";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

/**
 * Attendance reconciliation as a CSV (#166): one row per registration with the registered,
 * checked-in, no-show, adjusted and billable counts and the estimated and billable amounts.
 * Staff finance export (MANAGE_FINANCE); no attendee names. `?version=` names a saved version of
 * this event, otherwise the facts now. Follows the location filter (#413). Formula-safe.
 */
async function getHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "MANAGE_FINANCE", findActiveMembership);
    const { locationId } = await resolveLocationFilter(eventId, locationParam(request));
    const versionId = new URL(request.url).searchParams.get("version");
    const { result, versionLabel, factsChanged } = await getAttendanceReconciliationExport(eventId, { locationId, versionId });
    return new Response(toCsv(reconciliationCsvRows(result, { versionLabel, factsChanged })), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${eventId}-attendance-reconciliation.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    if (error instanceof AttendanceReconciliationError) return Response.json({ error: error.code, message: error.message }, { status: 404 });
    logError("Unable to export attendance reconciliation", error);
    return Response.json({ error: "ATTENDANCE_RECONCILIATION_EXPORT_FAILED" }, { status: 500 });
  }
}

export const GET = withRequestContext(getHandler);
