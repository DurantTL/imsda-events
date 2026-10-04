import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { billingResponsibilityCsvRows } from "@/modules/billing-responsibility/domain";
import { BillingResponsibilityError, getBillingResponsibilityExport } from "@/modules/billing-responsibility/repository";
import { findActiveMembership } from "@/modules/events/repository";
import { locationParam, resolveLocationFilter } from "@/modules/event-locations/filter";
import { toCsv } from "@/modules/reporting/csv";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

/**
 * Who is billed for each registration, and whether that party's billing contact is ready (#165).
 * Staff finance export (MANAGE_FINANCE): the contact's name, role and email, never a phone number,
 * birth date, or any attendee detail. Follows the location filter (#413).
 */
async function getHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "MANAGE_FINANCE", findActiveMembership);
    const { locationId } = await resolveLocationFilter(eventId, locationParam(request));
    const { groups, invoiceGrouping } = await getBillingResponsibilityExport(eventId, { locationId });
    return new Response(toCsv(billingResponsibilityCsvRows(groups, invoiceGrouping)), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${eventId}-billing-responsibility.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    if (error instanceof BillingResponsibilityError) return Response.json({ error: error.code, message: error.message }, { status: 404 });
    logError("Unable to export billing responsibility", error);
    return Response.json({ error: "BILLING_RESPONSIBILITY_EXPORT_FAILED" }, { status: 500 });
  }
}

export const GET = withRequestContext(getHandler);
