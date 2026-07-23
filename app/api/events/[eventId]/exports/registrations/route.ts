import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { findActiveMembership } from "@/modules/events/repository";
import { listRegistrations } from "@/modules/registrations/repository";
import { toCsv } from "@/modules/reporting/csv";

export async function GET(
  _request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  try {
    const { eventId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "VIEW_REPORTS", findActiveMembership);
    const registrations = await listRegistrations(eventId);
    const rows: Array<Array<string | number>> = [[
      "Confirmation code",
      "Account holder",
      "Email",
      "Status",
      "Attendees",
      "Total",
      "Net received",
      "Balance",
    ]];
    for (const registration of registrations) {
      rows.push([
        registration.confirmationCode,
        `${registration.accountHolder.firstName} ${registration.accountHolder.lastName}`,
        registration.accountHolder.email,
        registration.status,
        registration.attendeeCount,
        (registration.totalAmountCents / 100).toFixed(2),
        (registration.paidCents / 100).toFixed(2),
        (registration.balanceCents / 100).toFixed(2),
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
    console.error("Unable to export registrations", error);
    return Response.json({ error: "REGISTRATION_EXPORT_FAILED" }, { status: 500 });
  }
}
