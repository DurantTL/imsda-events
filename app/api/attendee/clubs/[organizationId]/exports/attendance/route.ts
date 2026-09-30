import { withRequestContext } from "@/lib/request-context";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { attendanceExportCsv, attendanceExportFileName, attendanceGroupOf } from "@/modules/club-meeting-notes/attendance";
import { clubMeetingNoteApiError } from "@/modules/club-meeting-notes/api-errors";
import { isMeetingDate } from "@/modules/club-meeting-notes/domain";
import { loadAttendanceExport } from "@/modules/club-meeting-notes/repository";
import { actorAttribution, requireClubCapability } from "@/modules/club-rosters/access";
import { rosterYearView } from "@/modules/club-rosters/domain";

type RouteContext = { params: Promise<{ organizationId: string }> };

/**
 * Meeting attendance export (#653): CSV with the club name and year, one row
 * per member, one column per meeting that took attendance, then totals and
 * percent attended. Same gate as the monthly report (`submitReports`).
 * Filters: `year` (club year), `from` and `to` (YYYY-MM-DD). Names only.
 */
async function getHandler(request: Request, context: RouteContext) {
  try {
    const { organizationId } = await context.params;
    const access = await requireClubCapability(organizationId, "submitReports");
    const params = new URL(request.url).searchParams;
    const from = params.get("from") || undefined;
    const to = params.get("to") || undefined;
    for (const date of [from, to]) {
      if (date !== undefined && !isMeetingDate(date)) {
        return Response.json({ error: "INVALID_DATE_RANGE", message: "Enter real dates for the export range." }, { status: 400 });
      }
    }
    if (from && to && from > to) {
      return Response.json({ error: "INVALID_DATE_RANGE", message: "The start date must be on or before the end date." }, { status: 400 });
    }
    const { clubYear } = rosterYearView(params.get("year") ?? undefined);
    const data = await loadAttendanceExport(organizationId, clubYear, { from, to });
    const csv = attendanceExportCsv(
      { clubName: data.clubName, clubYear, from, to },
      data.meetings,
      data.members.map((member) => ({ id: member.id, firstName: member.firstName, lastName: member.lastName, group: attendanceGroupOf(member) })),
      data.marks,
    );
    const actor = actorAttribution(access.actor);
    await writeAuditLog({
      ...("userId" in actor ? { actorUserId: actor.userId } : {}),
      action: "CLUB_ATTENDANCE_EXPORT_DOWNLOADED",
      entityType: "Organization",
      entityId: organizationId,
      summary: "Downloaded a club's meeting attendance export as CSV.",
      metadata: {
        organizationId, clubYear, meetingCount: data.meetings.length, memberCount: data.members.length,
        ...("accountId" in actor ? { accountId: actor.accountId } : {}),
        ...("actAsId" in actor ? { actAsId: actor.actAsId } : {}),
      },
    });
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `attachment; filename="${attendanceExportFileName(clubYear)}"`,
      },
    });
  } catch (error) {
    return clubMeetingNoteApiError(error, "Exporting meeting attendance");
  }
}

export const GET = withRequestContext(getHandler);
