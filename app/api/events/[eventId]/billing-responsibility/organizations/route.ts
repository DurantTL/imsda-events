import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { searchResponsibleOrganizations } from "@/modules/billing-responsibility/repository";
import { findActiveMembership } from "@/modules/events/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

/**
 * Picker search for linking a registration to its responsible organization (#165). MANAGE_FINANCE
 * on the event only; matches name only and returns name, type and city, so it cannot be used to
 * browse the organization directory.
 */
async function getHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "MANAGE_FINANCE", findActiveMembership);
    const query = new URL(request.url).searchParams.get("q") ?? "";
    const organizations = await searchResponsibleOrganizations(query);
    return Response.json({ organizations }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    logError("Unable to search organizations for billing", error);
    return Response.json({ error: "ORGANIZATION_SEARCH_FAILED" }, { status: 500 });
  }
}

export const GET = withRequestContext(getHandler);
