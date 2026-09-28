import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { actorAttribution, requireRosterAccess } from "@/modules/club-rosters/access";
import { rosterApiError } from "@/modules/club-rosters/api-errors";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { runRosterExport } from "@/modules/club-rosters/export-repository";
import { rosterExportRequestSchema } from "@/modules/club-rosters/export-schemas";
import { withRequestContext } from "@/lib/request-context";

/**
 * Builds a preview or downloads a CSV for the chosen columns (#490). POST,
 * not GET: even a preview opens birth dates when that column is chosen, and
 * a download is always an audited action, never a cacheable read.
 */
async function postHandler(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId } = await context.params;
    const access = await requireRosterAccess(organizationId);
    const input = rosterExportRequestSchema.parse(await request.json());
    const clubYear = clubYearFor(new Date());
    const result = await runRosterExport(
      organizationId,
      clubYear,
      input,
      access.capabilities.seeBirthDates,
      actorAttribution(access.actor),
    );
    if ("csv" in result) {
      return new Response(result.csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="roster-export.csv"',
          "Cache-Control": "private, no-store, max-age=0",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    return Response.json({ headers: result.headers, rows: result.rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return rosterApiError(error, "Building a roster export");
  }
}

export const POST = withRequestContext(postHandler);
