import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { getImportReconciliation } from "@/modules/imports/repository";
import { findActiveMembership } from "@/modules/events/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

async function getHandler(_request: Request, context: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "MANAGE_IMPORTS", findActiveMembership);
    return Response.json(await getImportReconciliation(eventId));
  } catch (error) {
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    logError("Import reconciliation failed", error);
    return Response.json({ error: "RECONCILIATION_FAILED", message: "Reconciliation totals could not be loaded." }, { status: 500 });
  }
}

export const GET = withRequestContext(getHandler);
