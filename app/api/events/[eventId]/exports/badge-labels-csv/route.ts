import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { badgeCsvFilename, buildBadgeCsvRows, eligiblePositionField } from "@/modules/checkin/badge-csv";
import { normalizeBadgeShowAttendeeType } from "@/modules/checkin/badge-labels";
import { activeRegistrationStatuses } from "@/modules/events/lifecycle";
import { findActiveMembership, findEventSlug } from "@/modules/events/repository";
import { listRegistrations } from "@/modules/registrations/repository";
import { toCsv } from "@/modules/reporting/csv";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

/**
 * Name-badge CSV for Avery Design & Print (mail merge with a QR code). Same
 * permission and same roster as the printable badge page. ID is the
 * confirmation code, never an attendee pass token.
 */
async function getHandler(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(
      await getCurrentSession(),
      eventId,
      "MANAGE_CHECK_IN",
      findActiveMembership,
    );
    const slug = await findEventSlug(eventId);
    if (!slug) {
      return Response.json({ error: "EVENT_NOT_FOUND" }, { status: 404 });
    }
    const registrations = await listRegistrations(eventId, { statuses: activeRegistrationStatuses });
    // Position is an explicit choice from the eligible list; nothing is guessed.
    const searchParams = new URL(request.url).searchParams;
    const requested = searchParams.get("positionField") || undefined;
    const positionField = eligiblePositionField(registrations, requested);
    if (requested && !positionField) {
      return Response.json({
        error: "POSITION_FIELD_NOT_ELIGIBLE",
        message: "That field cannot be used as the Position column.",
      }, { status: 400 });
    }
    // Same setting as the badge page: `type=0` leaves the Attendee type column empty.
    const rows = buildBadgeCsvRows(
      registrations,
      positionField,
      normalizeBadgeShowAttendeeType(searchParams.getAll("type")),
    );
    // Counts only: an audit row never carries an attendee's name.
    await writeAuditLog({
      eventId,
      actorUserId: access.user.id,
      action: "BADGE_LABELS_CSV_EXPORTED",
      entityType: "Event",
      entityId: eventId,
      summary: "Downloaded the name badge CSV for Avery Design & Print.",
      metadata: { rowCount: rows.length - 1 },
    });
    return new Response(toCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${badgeCsvFilename(slug)}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    logError("Unable to export name badge CSV", error);
    return Response.json({ error: "BADGE_LABELS_CSV_EXPORT_FAILED" }, { status: 500 });
  }
}

export const GET = withRequestContext(getHandler);
