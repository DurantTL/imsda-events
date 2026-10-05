import { AccessDeniedError, effectivePermissions, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { findActiveMembership } from "@/modules/events/repository";
import { listRegistrations } from "@/modules/registrations/repository";
import {
  attendeeListingCsv,
  buildAttendeeListingRows,
  filterAttendeeListing,
  parseAttendeeListingQuery,
} from "@/modules/registrations/attendee-listing";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

/**
 * The attendee listing as CSV (#784): the same rows and columns the page shows
 * for the same filters. Needs what the registrations export needs
 * (VIEW_REPORTS) plus VIEW_SENSITIVE_DATA, which the page itself requires.
 */
async function getHandler(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "VIEW_REPORTS", findActiveMembership);
    const permissions = new Set(effectivePermissions(access.user, access.membership));
    // Refused before anything is read.
    if (!permissions.has("VIEW_SENSITIVE_DATA")) {
      throw new AccessDeniedError("Your event role does not include access to attendee names and answers.", 403, "PERMISSION_DENIED");
    }
    const query = parseAttendeeListingQuery(new URL(request.url).searchParams);
    const registrations = await listRegistrations(eventId, { statuses: query.statuses });
    const rows = filterAttendeeListing(buildAttendeeListingRows(registrations), query);
    return new Response(attendeeListingCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${eventId}-attendees.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    logError("Unable to export attendees", error);
    return Response.json({ error: "ATTENDEE_EXPORT_FAILED" }, { status: 500 });
  }
}

export const GET = withRequestContext(getHandler);
