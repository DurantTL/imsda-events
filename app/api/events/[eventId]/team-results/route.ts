import { getCurrentSession } from "@/modules/access/current-session";
import { clubTeamApiError } from "@/modules/club-teams/api-errors";
import { listTeamResults } from "@/modules/club-teams/results-repository";
import { teamResultsCsvRows } from "@/modules/club-teams/results-domain";
import { findActiveMembership } from "@/modules/events/repository";
import { requireClubReportsAccess } from "@/modules/reporting/club-reports-access";
import { toCsv } from "@/modules/reporting/csv";
import { withRequestContext } from "@/lib/request-context";

/**
 * The team results report (#809) as data, or as a CSV with `?format=csv`. For staff with report access, or an event
 * administrator of this club event: the same people who read the other club reports.
 */
async function getHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await context.params;
    await requireClubReportsAccess(await getCurrentSession(), eventId, findActiveMembership);
    const rows = await listTeamResults(eventId);
    if (new URL(request.url).searchParams.get("format") === "csv") {
      const safeEventId = eventId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100) || "event";
      return new Response(toCsv(teamResultsCsvRows(rows)), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${safeEventId}-team-results.csv"`,
          "Cache-Control": "private, no-store, max-age=0",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    return Response.json({ teams: rows }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    return clubTeamApiError(error, "Loading the team results");
  }
}

export const GET = withRequestContext(getHandler);
