import { AccessDeniedError, effectivePermissions, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { findActiveMembership } from "@/modules/events/repository";
import { listRegistrations } from "@/modules/registrations/repository";
import { computeRegistrationFlags } from "@/modules/registrations/flags";
import { listNotesForRegistration } from "@/modules/notes/repository";
import { toCsv } from "@/modules/reporting/csv";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

async function getHandler(
  _request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "VIEW_REPORTS", findActiveMembership);
    // A general export is read with only the exporting user's own
    // permissions: a note restricted to a permission this user does not hold
    // must not surface here even though the export otherwise covers everyone.
    const actorPermissions = new Set(effectivePermissions(access.user, access.membership));
    const registrations = await listRegistrations(eventId);
    const rows: Array<Array<string | number>> = [[
      "Confirmation code",
      "Account holder",
      "Email",
      "Status",
      "Submitted at (ISO 8601)",
      "Attendees",
      "Total",
      "Net received",
      "Balance",
      "Flags",
      "Visible staff notes",
    ]];
    for (const registration of registrations) {
      const flags = computeRegistrationFlags(registration);
      const visibleNotes = await listNotesForRegistration(eventId, registration.id, actorPermissions);
      rows.push([
        registration.confirmationCode,
        `${registration.accountHolder.firstName} ${registration.accountHolder.lastName}`,
        registration.accountHolder.email,
        registration.status,
        registration.submittedAt ?? "",
        registration.attendeeCount,
        (registration.totalAmountCents / 100).toFixed(2),
        (registration.paidCents / 100).toFixed(2),
        (registration.balanceCents / 100).toFixed(2),
        flags.map((flag) => flag.label).join("; "),
        visibleNotes.map((note) => note.body).join(" | "),
      ]);
    }
    return new Response(toCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${eventId}-registrations.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    logError("Unable to export registrations", error);
    return Response.json({ error: "REGISTRATION_EXPORT_FAILED" }, { status: 500 });
  }
}

export const GET = withRequestContext(getHandler);
