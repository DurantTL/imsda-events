import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { findActiveMembership } from "@/modules/events/repository";
import { listChurchAmountsOwed } from "@/modules/club-registrations/repository";
import { toCsv } from "@/modules/reporting/csv";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

/**
 * What each club owes for this event, billed to the church (#409). Staff
 * finance export only: no birth dates, medical answers, or other attendee
 * detail, only what a church invoice needs — the club, the confirmation, the
 * headcount, and the amount already priced by the normal pricing engine.
 */
async function getHandler(
  _request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  try {
    const { eventId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "MANAGE_FINANCE", findActiveMembership);
    const owed = await listChurchAmountsOwed(eventId);
    const rows: Array<Array<string | number>> = [[
      "Organization",
      "Confirmation code",
      "Status",
      "Attendees",
      "Amount owed",
    ]];
    for (const row of owed) {
      rows.push([
        row.organizationName,
        row.confirmationCode,
        row.status,
        row.attendeeCount,
        (row.amountOwedCents / 100).toFixed(2),
      ]);
    }
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
