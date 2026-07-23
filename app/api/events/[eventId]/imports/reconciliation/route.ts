import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { getImportReconciliation } from "@/modules/imports/repository";
import { findActiveMembership } from "@/modules/events/repository";

export async function GET(_request: Request, context: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "MANAGE_IMPORTS", findActiveMembership);
    return Response.json(await getImportReconciliation(eventId));
  } catch (error) {
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    console.error("Import reconciliation failed", error);
    return Response.json({ error: "RECONCILIATION_FAILED", message: "Reconciliation totals could not be loaded." }, { status: 500 });
  }
}
