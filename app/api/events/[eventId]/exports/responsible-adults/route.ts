import { AccessDeniedError, effectivePermissions, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { findActiveMembership } from "@/modules/events/repository";
import { GuardianAuthorityError, getResponsibleAdultExportRows } from "@/modules/guardian-authority/repository";
import { responsibleAdultsCsv } from "@/modules/guardian-authority/export";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

/**
 * Minors and their responsible adults for lodging and check-in (#131). The same permissions as the people
 * list it mirrors: reports plus attendee names. Every cell goes through the shared CSV writer, which defuses
 * spreadsheet formulas. Names, registration codes and the age number only: nothing medical.
 */

async function getHandler(_request: Request, context: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "VIEW_REPORTS", findActiveMembership);
    if (!new Set(effectivePermissions(access.user, access.membership)).has("VIEW_SENSITIVE_DATA")) {
      throw new AccessDeniedError("Your event role does not include access to attendee names.", 403, "PERMISSION_DENIED");
    }
    const safeEventId = eventId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100) || "event";
    return new Response(responsibleAdultsCsv(await getResponsibleAdultExportRows(eventId)), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeEventId}-responsible-adults.csv"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    if (error instanceof GuardianAuthorityError && error.code === "EVENT_NOT_FOUND") return Response.json({ error: error.code }, { status: 404 });
    logError("Unable to export responsible adults", error);
    return Response.json({ error: "RESPONSIBLE_ADULT_EXPORT_FAILED" }, { status: 500 });
  }
}

export const GET = withRequestContext(getHandler);
