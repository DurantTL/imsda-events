import { AccessDeniedError } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { findActiveMembership } from "@/modules/events/repository";
import {
  buildCampingReport,
  buildDutiesActivitiesReport,
  buildSpecialRolesReport,
  buildSpiritualMilestonesReport,
  campingReportCsv,
  clubReportKinds,
  dutiesActivitiesReportCsv,
  spiritualMilestonesReportCsv,
  specialRolesReportCsv,
  type ClubReportKind,
} from "@/modules/reporting/club-event-reports";
import { getClubEventRecords } from "@/modules/reporting/club-event-reports-repository";
import { requireClubReportsAccess } from "@/modules/reporting/club-reports-access";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

function isClubReportKind(value: string | null): value is ClubReportKind {
  return clubReportKinds.includes(value as ClubReportKind);
}

function csvForKind(kind: ClubReportKind, data: Awaited<ReturnType<typeof getClubEventRecords>>) {
  switch (kind) {
    case "camping":
      return campingReportCsv(buildCampingReport(data.clubs));
    case "duties-activities":
      return dutiesActivitiesReportCsv(buildDutiesActivitiesReport(data.clubs, data.assignments));
    case "milestones":
      return spiritualMilestonesReportCsv(buildSpiritualMilestonesReport(data.clubs));
    case "special-roles":
      return specialRolesReportCsv(buildSpecialRolesReport(data.clubs));
  }
}

async function getHandler(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  try {
    const { eventId } = await context.params;
    const kind = new URL(request.url).searchParams.get("report");
    if (!isClubReportKind(kind)) {
      return Response.json(
        { error: "INVALID_REPORT", message: "Choose camping, duties-activities, milestones, or special-roles." },
        { status: 400 },
      );
    }

    await requireClubReportsAccess(await getCurrentSession(), eventId, findActiveMembership);
    const data = await getClubEventRecords(eventId);
    const safeEventId = eventId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100) || "event";
    return new Response(csvForKind(kind, data), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeEventId}-club-${kind}.csv"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    logError("Unable to export club report", error);
    return Response.json({ error: "CLUB_REPORT_EXPORT_FAILED" }, { status: 500 });
  }
}

export const GET = withRequestContext(getHandler);
