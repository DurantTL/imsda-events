import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { getMerchandiseCatalog, saveCatalog } from "@/modules/merchandise/catalog-repository";
import { withRequestContext } from "@/lib/request-context";

type Context = { params: Promise<{ eventId: string }> };
function errorResponse(error: unknown) {
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof SyntaxError) return Response.json({ error: "INVALID_JSON", message: "The request is not valid JSON." }, { status: 400 });
  if (error instanceof Error && ("issues" in error || error.name === "ZodError")) return Response.json({ error: "INVALID_MERCHANDISE_CATALOG", message: error.message }, { status: 400 });
  return Response.json({ error: "MERCHANDISE_CATALOG_FAILED", message: "The merchandise catalog request could not be completed." }, { status: 500 });
}
/** Staff-only, like every other route under /api/events/{eventId}: this
 * returns the full admin catalog shape (isArchived, position, sku, ...). The
 * attendee-safe projection lives at GET .../merchandise/preview. */
async function getHandler(_request: Request, context: Context) {
  try {
    const { eventId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    return Response.json(await getMerchandiseCatalog(eventId));
  } catch (error) { return errorResponse(error); }
}
async function saveHandler(request: Request, context: Context) {
  const originError = rejectCrossOriginRequest(request); if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    return Response.json(await saveCatalog(eventId, await request.json(), access.user.id));
  } catch (error) { return errorResponse(error); }
}
export const GET = withRequestContext(getHandler);
export const PUT = withRequestContext(saveHandler);
export const PATCH = withRequestContext(saveHandler);
