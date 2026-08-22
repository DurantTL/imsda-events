import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { createProduct, getMerchandiseCatalog } from "@/modules/merchandise/catalog-repository";
import { withRequestContext } from "@/lib/request-context";

type Context = { params: Promise<{ eventId: string }> };
async function handler(request: Request, context: Context) {
  try {
    const originError = rejectCrossOriginRequest(request); if (originError) return originError;
    const { eventId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    if (request.method === "GET") return Response.json({ products: (await getMerchandiseCatalog(eventId)).products });
    const product = await createProduct(eventId, await request.json(), access.user.id);
    return Response.json({ product }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && "status" in error) return Response.json({ error: (error as Error & { code?: string }).code ?? "ACCESS_DENIED", message: error.message }, { status: Number((error as Error & { status: number }).status) });
    if (error instanceof SyntaxError) return Response.json({ error: "INVALID_JSON", message: "The request is not valid JSON." }, { status: 400 });
    return Response.json({ error: "MERCHANDISE_PRODUCT_FAILED", message: error instanceof Error ? error.message : "The product request could not be completed." }, { status: 400 });
  }
}
export const GET = withRequestContext(handler);
export const POST = withRequestContext(handler);
