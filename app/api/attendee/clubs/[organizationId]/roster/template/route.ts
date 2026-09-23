import { requireRosterAccess } from "@/modules/club-rosters/access";
import { rosterApiError } from "@/modules/club-rosters/api-errors";
import { rosterCsvTemplate } from "@/modules/club-rosters/csv-import";
import { withRequestContext } from "@/lib/request-context";

/** The roster CSV template (#384): column names only, nothing from the roster. */
async function getHandler(_request: Request, context: { params: Promise<{ organizationId: string }> }) {
  try {
    const { organizationId } = await context.params;
    await requireRosterAccess(organizationId);
    return new Response(rosterCsvTemplate(), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="club-roster-template.csv"',
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return rosterApiError(error, "Downloading the roster template");
  }
}

export const GET = withRequestContext(getHandler);
