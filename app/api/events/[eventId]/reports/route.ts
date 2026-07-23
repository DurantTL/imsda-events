import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { findActiveMembership } from "@/modules/events/repository";
import {
  operationalReportCsv,
  operationalReportKinds,
  type OperationalReportKind,
} from "@/modules/reporting/operational-reports";
import { getOperationalReport } from "@/modules/reporting/repository";

function isOperationalReportKind(value: string | null): value is OperationalReportKind {
  return operationalReportKinds.includes(value as OperationalReportKind);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  try {
    const { eventId } = await context.params;
    const kind = new URL(request.url).searchParams.get("report");
    if (!isOperationalReportKind(kind)) {
      return Response.json(
        {
          error: "INVALID_REPORT",
          message: "Choose roster, meals, housing, or seminars.",
        },
        { status: 400 },
      );
    }

    await requirePermission(
      await getCurrentSession(),
      eventId,
      "VIEW_REPORTS",
      findActiveMembership,
    );
    const report = await getOperationalReport(eventId);
    const safeEventId = eventId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100) || "event";
    return new Response(operationalReportCsv(report, kind), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeEventId}-${kind}.csv"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return Response.json(
        { error: error.code, message: error.message },
        { status: error.status },
      );
    }
    console.error("Unable to export operational report", error);
    return Response.json(
      { error: "OPERATIONAL_REPORT_EXPORT_FAILED" },
      { status: 500 },
    );
  }
}
