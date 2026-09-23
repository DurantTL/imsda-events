import { AccessDeniedError, effectivePermissions, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { findActiveMembership } from "@/modules/events/repository";
import {
  buildClassRosters,
  buildClubSchedule,
  buildSiteRoster,
  classRostersCsv,
  clubScheduleCsv,
  siteRosterCsv,
} from "@/modules/honors/roster-domain";
import { getHonorRosterData } from "@/modules/honors/roster-repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

function csvResponse(body: string, filename: string) {
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Honors Weekend rosters as CSV (#360): classes, the site roster, or one club's schedule. */
async function getHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await context.params;
    const url = new URL(request.url);
    const view = url.searchParams.get("view");
    if (view !== "classes" && view !== "site" && view !== "club") {
      return Response.json({ error: "INVALID_ROSTER", message: "Choose classes, site, or club." }, { status: 400 });
    }
    const session = await getCurrentSession();
    const access = await requirePermission(session, eventId, "VIEW_REPORTS", findActiveMembership);
    const includeDietary = view === "site" && effectivePermissions(access.user, access.membership).includes("VIEW_SENSITIVE_DATA");
    const data = await getHonorRosterData(eventId, { includeDietary });
    if (!data) return Response.json({ error: "EVENT_NOT_FOUND" }, { status: 404 });
    const safeEventId = eventId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100) || "event";

    if (view === "classes") {
      return csvResponse(classRostersCsv(buildClassRosters(data.sessions, data.offerings, data.enrollments, data.attendees)), `${safeEventId}-class-rosters.csv`);
    }
    if (view === "site") {
      return csvResponse(siteRosterCsv(buildSiteRoster(data.attendees), includeDietary), `${safeEventId}-site-roster.csv`);
    }
    const clubId = url.searchParams.get("club") ?? "";
    if (!data.clubs.some((club) => club.id === clubId)) {
      return Response.json({ error: "CLUB_NOT_FOUND", message: "That club isn't registered for this site." }, { status: 404 });
    }
    return csvResponse(
      clubScheduleCsv(buildClubSchedule(clubId, data.sessions, data.offerings, data.enrollments, data.attendees)),
      `${safeEventId}-club-schedule.csv`,
    );
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    logError("Unable to export Honors Weekend roster", error);
    return Response.json({ error: "HONOR_ROSTER_EXPORT_FAILED" }, { status: 500 });
  }
}

export const GET = withRequestContext(getHandler);
