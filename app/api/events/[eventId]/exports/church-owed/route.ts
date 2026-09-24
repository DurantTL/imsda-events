import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { findActiveMembership } from "@/modules/events/repository";
import { listChurchAmountsOwed } from "@/modules/club-registrations/repository";
import { churchAmountsOwedCsvRows } from "@/modules/club-registrations/church-owed";
import { toCsv } from "@/modules/reporting/csv";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

/**
 * What each church owes for this event (#409): an estimate, billed to the
 * church after the event, not paid online. Staff finance export only: no
 * birth dates, medical answers, or other attendee detail, only what a church
 * invoice needs — the church, the club, the confirmation, the status, the
 * headcount, and the amount already priced by the normal pricing engine.
 * Waitlisted and cancelled clubs appear with $0 owed.
 */
async function getHandler(
  _request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  try {
    const { eventId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "MANAGE_FINANCE", findActiveMembership);
    const owed = await listChurchAmountsOwed(eventId);
    const rows = churchAmountsOwedCsvRows(owed);
    return new Response(toCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${eventId}-church-owed.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    logError("Unable to export church amounts owed", error);
    return Response.json({ error: "CHURCH_OWED_EXPORT_FAILED" }, { status: 500 });
  }
}

export const GET = withRequestContext(getHandler);
