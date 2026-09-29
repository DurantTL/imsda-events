import { AccessDeniedError } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { findActiveMembership } from "@/modules/events/repository";
import { checkInBookCsv, parseCheckInBookStatuses } from "@/modules/reporting/check-in-book";
import { getCheckInBookData } from "@/modules/reporting/check-in-book-repository";
import { locationParam } from "@/modules/event-locations/filter";
import { requireClubReportsAccess } from "@/modules/reporting/club-reports-access";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

async function getHandler(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  try {
    const { eventId } = await context.params;
    await requireClubReportsAccess(await getCurrentSession(), eventId, findActiveMembership);
    const params = new URL(request.url).searchParams;
    const data = await getCheckInBookData(eventId, {
      statuses: parseCheckInBookStatuses(params.getAll("status")),
      extraFieldKey: params.get("extra"),
      // ?location= narrows the book to one location; without it every location is combined (#413).
      location: locationParam(request),
    });
    if (!data) return Response.json({ error: "EVENT_NOT_FOUND" }, { status: 404 });
    const safeEventId = eventId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100) || "event";
    return new Response(checkInBookCsv(data.book), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeEventId}-check-in-book.csv"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    logError("Unable to export check-in book", error);
    return Response.json({ error: "CHECK_IN_BOOK_EXPORT_FAILED" }, { status: 500 });
  }
}

export const GET = withRequestContext(getHandler);
